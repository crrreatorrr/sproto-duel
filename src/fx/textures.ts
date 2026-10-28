import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

let glow: THREE.Texture | null = null;
/** Soft radial falloff used for glow sprites. */
export function glowTexture(): THREE.Texture {
  if (glow) return glow;
  const [c, g] = canvas(128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  glow.colorSpace = THREE.SRGBColorSpace;
  return glow;
}

/** Deterministic pseudo-random so procedural textures look the same every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

type RGB = [number, number, number];
type Rand = () => number;

/** Palette and decoration for the procedural arena floor. Colours are 0-255 sRGB. */
export interface FloorStyle {
  /** Mortar between flagstones (shows through the gaps). */
  gap: string;
  /** Flagstone colour: `stone` plus a random shade in [0, stoneRange) on every channel. */
  stone: RGB;
  stoneRange: number;
  grit: RGB;
  gritRange: number;
  gritAlpha: number;
  rune: string;
  glyph: string;
  mark: string;
  /** Theme dressing drawn over the stones. */
  extras?: 'moss' | 'lava' | 'frost' | 'sand' | 'void';
}

export const MOONLIT_FLOOR: FloorStyle = {
  gap: '#3a3742',
  stone: [48, 45, 56],
  stoneRange: 22,
  grit: [30, 30, 40],
  gritRange: 50,
  gritAlpha: 0.25,
  rune: 'rgba(120,170,255,0.55)',
  glyph: 'rgba(140,190,255,0.6)',
  mark: 'rgba(255,255,255,0.12)',
};

const rgb = (c: RGB, v: number) => `rgb(${c[0] + v},${c[1] + v},${c[2] + v})`;

/** Placeholder arena floor: concentric flagstones with a rune circle. Used when no floor texture is supplied. */
export function drawArenaFloor(style: FloorStyle = MOONLIT_FLOOR): HTMLCanvasElement {
  const size = 2048;
  const [c, g] = canvas(size);
  const r = rng(7);
  const cx = size / 2;
  g.fillStyle = style.gap;
  g.fillRect(0, 0, size, size);

  // Flagstone rings.
  const rings = 11;
  for (let i = 0; i < rings; i++) {
    const r0 = (i / rings) * cx;
    const r1 = ((i + 1) / rings) * cx;
    const count = Math.max(6, Math.round((i + 1) * 7));
    for (let j = 0; j < count; j++) {
      const a0 = (j / count) * Math.PI * 2 + i * 0.37;
      const a1 = ((j + 1) / count) * Math.PI * 2 + i * 0.37;
      g.fillStyle = rgb(style.stone, Math.floor(r() * style.stoneRange));
      g.beginPath();
      g.arc(cx, cx, r1 - 3, a0 + 0.004, a1 - 0.004);
      g.arc(cx, cx, Math.max(0, r0 + 3), a1 - 0.004, a0 + 0.004, true);
      g.closePath();
      g.fill();
    }
  }

  // Grit.
  const gr = style.grit;
  for (let i = 0; i < 26000; i++) {
    const v = Math.floor(r() * style.gritRange);
    g.fillStyle = `rgba(${gr[0] + v},${gr[1] + v},${gr[2] + v},${style.gritAlpha})`;
    g.fillRect(r() * size, r() * size, 2, 2);
  }

  if (style.extras) FLOOR_EXTRAS[style.extras](g, r, size);

  // Rune circle around the middle of the arena.
  g.strokeStyle = style.rune;
  g.lineWidth = 6;
  for (const rr of [0.18, 0.21, 0.6, 0.625]) {
    g.beginPath();
    g.arc(cx, cx, cx * rr, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = 'bold 34px serif';
  g.fillStyle = style.glyph;
  const glyphs = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    g.save();
    g.translate(cx + Math.cos(a) * cx * 0.6125, cx + Math.sin(a) * cx * 0.6125);
    g.rotate(a + Math.PI / 2);
    g.fillText(glyphs[i % glyphs.length], -12, 12);
    g.restore();
  }
  // Duelist marks.
  g.strokeStyle = style.mark;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx, cx * 0.22);
  g.lineTo(cx, cx * 1.78);
  g.stroke();
  return c;
}

export function arenaFloorTexture(style?: FloorStyle): THREE.Texture {
  const tex = new THREE.CanvasTexture(drawArenaFloor(style));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function blob(g: CanvasRenderingContext2D, x: number, y: number, radius: number, inner: string, outer: string): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/** A wandering crack: a random walk drawn as one polyline. */
function crack(g: CanvasRenderingContext2D, r: Rand, x: number, y: number, steps: number, len: number): void {
  let a = r() * Math.PI * 2;
  g.beginPath();
  g.moveTo(x, y);
  for (let k = 0; k < steps; k++) {
    a += (r() - 0.5) * 1.3;
    x += Math.cos(a) * len * (0.5 + r());
    y += Math.sin(a) * len * (0.5 + r());
    g.lineTo(x, y);
  }
  g.stroke();
}

/** Random point inside the floor disc (radius as a fraction of the half-size, biased by `pow`). */
function inDisc(r: Rand, size: number, min = 0, max = 0.98, pow = 0.5): [number, number] {
  const a = r() * Math.PI * 2;
  const d = (min + (max - min) * Math.pow(r(), pow)) * size * 0.5;
  return [size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d];
}

const FLOOR_EXTRAS: Record<NonNullable<FloorStyle['extras']>, (g: CanvasRenderingContext2D, r: Rand, size: number) => void> = {
  moss(g, r, size) {
    for (let i = 0; i < 170; i++) {
      const [x, y] = inDisc(r, size, 0.05, 1, 0.4);
      blob(g, x, y, 30 + r() * 110, `rgba(${60 + r() * 30},${100 + r() * 40},${35 + r() * 20},0.42)`, 'rgba(50,90,30,0)');
    }
    // Leaf litter.
    for (let i = 0; i < 1400; i++) {
      const [x, y] = inDisc(r, size, 0, 1, 0.45);
      const gold = r() < 0.35;
      g.fillStyle = gold ? `rgba(${190 + r() * 50},${150 + r() * 40},60,0.55)` : `rgba(${70 + r() * 40},${110 + r() * 50},40,0.55)`;
      g.save();
      g.translate(x, y);
      g.rotate(r() * Math.PI);
      g.beginPath();
      g.ellipse(0, 0, 7 + r() * 6, 3 + r() * 2, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    // Grass creeping in from the edge.
    g.lineWidth = 2;
    for (let i = 0; i < 2600; i++) {
      const [x, y] = inDisc(r, size, 0.84, 1.0, 1);
      const a = Math.atan2(y - size / 2, x - size / 2) + Math.PI + (r() - 0.5) * 1.2;
      const l = 8 + r() * 22;
      g.strokeStyle = `rgba(${50 + r() * 40},${100 + r() * 60},${30 + r() * 20},0.7)`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  },
  lava(g, r, size) {
    // Glowing fissures crossing the basalt, with a hot core.
    for (let i = 0; i < 70; i++) {
      const [x, y] = inDisc(r, size, 0.1, 1, 0.5);
      const seed = r() * 1e6;
      for (const [w, col] of [[9, 'rgba(255,70,10,0.55)'], [3.5, 'rgba(255,190,80,0.95)']] as const) {
        const rr = rng(Math.floor(seed) + 1);
        g.lineWidth = w;
        g.strokeStyle = col;
        crack(g, rr, x, y, 6 + Math.floor(rr() * 6), 18);
      }
    }
    for (let i = 0; i < 900; i++) {
      const [x, y] = inDisc(r, size);
      g.fillStyle = `rgba(255,${120 + r() * 100},40,${0.3 + r() * 0.5})`;
      g.fillRect(x, y, 3, 3);
    }
  },
  frost(g, r, size) {
    for (let i = 0; i < 140; i++) {
      const [x, y] = inDisc(r, size, 0, 1, 0.5);
      blob(g, x, y, 40 + r() * 120, 'rgba(235,245,255,0.22)', 'rgba(235,245,255,0)');
    }
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(240,250,255,0.55)';
    for (let i = 0; i < 160; i++) {
      const [x, y] = inDisc(r, size);
      crack(g, r, x, y, 4 + Math.floor(r() * 5), 14);
    }
    // Snow drifted against the wall.
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, cx * 0.78, cx, cx, cx);
    grad.addColorStop(0, 'rgba(240,246,255,0)');
    grad.addColorStop(0.7, 'rgba(240,246,255,0.55)');
    grad.addColorStop(1, 'rgba(248,252,255,0.95)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 4000; i++) {
      const [x, y] = inDisc(r, size);
      g.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.5})`;
      g.fillRect(x, y, 2, 2);
    }
  },
  sand(g, r, size) {
    for (let i = 0; i < 190; i++) {
      const [x, y] = inDisc(r, size, 0.15, 1, 0.3);
      blob(g, x, y, 50 + r() * 150, `rgba(${215 + r() * 20},${178 + r() * 20},${118 + r() * 20},0.5)`, 'rgba(215,180,120,0)');
    }
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, cx * 0.8, cx, cx, cx);
    grad.addColorStop(0, 'rgba(222,186,128,0)');
    grad.addColorStop(1, 'rgba(222,186,128,0.85)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // Wind ripples.
    g.lineWidth = 2;
    for (let i = 0; i < 500; i++) {
      const [x, y] = inDisc(r, size, 0.3, 1, 0.5);
      g.strokeStyle = r() < 0.5 ? 'rgba(160,120,70,0.35)' : 'rgba(250,225,170,0.4)';
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 20, y - 6, x + 44 + r() * 30, y + (r() - 0.5) * 6);
      g.stroke();
    }
  },
  void(g, r, size) {
    for (let i = 0; i < 5000; i++) {
      const [x, y] = inDisc(r, size);
      const purple = r() < 0.5;
      g.fillStyle = purple ? `rgba(200,140,255,${0.2 + r() * 0.6})` : `rgba(160,255,190,${0.15 + r() * 0.4})`;
      g.fillRect(x, y, 2, 2);
    }
    for (let i = 0; i < 50; i++) {
      const [x, y] = inDisc(r, size, 0.2, 1, 0.5);
      g.lineWidth = 2.5;
      g.strokeStyle = r() < 0.55 ? 'rgba(190,110,255,0.8)' : 'rgba(110,255,170,0.7)';
      crack(g, r, x, y, 5 + Math.floor(r() * 6), 22);
    }
  },
};

/** Palette for the procedural tiling stone (walls, placeholder pillars). */
export interface StoneStyle {
  bg: string;
  brick: RGB;
  brickRange: number;
  grit: RGB;
  gritRange: number;
  gritAlpha: number;
  extras?: 'moss' | 'veins' | 'frost' | 'sand' | 'void';
}

export const MOONLIT_STONE: StoneStyle = {
  bg: '#6b6672',
  brick: [90, 86, 96],
  brickRange: 30,
  grit: [40, 40, 40],
  gritRange: 60,
  gritAlpha: 0.25,
};

export function drawStone(style: StoneStyle = MOONLIT_STONE): HTMLCanvasElement {
  const [c, g] = canvas(512);
  const r = rng(19);
  g.fillStyle = style.bg;
  g.fillRect(0, 0, 512, 512);
  const rows = 8;
  for (let y = 0; y < rows; y++) {
    const off = (y % 2) * 64;
    for (let x = -1; x < 4; x++) {
      g.fillStyle = rgb(style.brick, Math.floor(r() * style.brickRange));
      g.fillRect(x * 128 + off + 3, y * 64 + 3, 122, 58);
    }
  }
  const gr = style.grit;
  for (let i = 0; i < 9000; i++) {
    const v = Math.floor(r() * style.gritRange);
    g.fillStyle = `rgba(${gr[0] + v},${gr[1] + v},${gr[2] + v},${style.gritAlpha})`;
    g.fillRect(r() * 512, r() * 512, 2, 2);
  }
  switch (style.extras) {
    case 'moss':
      for (let i = 0; i < 70; i++) blob(g, r() * 512, r() * 512, 12 + r() * 40, 'rgba(70,120,40,0.55)', 'rgba(70,120,40,0)');
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(60,110,40,0.8)';
      for (let i = 0; i < 6; i++) crack(g, r, r() * 512, 0, 10, 24);
      break;
    case 'veins':
      for (const [w, col] of [[6, 'rgba(255,80,20,0.6)'], [2, 'rgba(255,190,90,1)']] as const) {
        const rr = rng(5);
        g.lineWidth = w;
        g.strokeStyle = col;
        for (let i = 0; i < 9; i++) crack(g, rr, rr() * 512, rr() * 512, 8, 20);
      }
      break;
    case 'frost':
      for (let i = 0; i < 50; i++) blob(g, r() * 512, r() * 512, 16 + r() * 50, 'rgba(240,248,255,0.35)', 'rgba(240,248,255,0)');
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      for (let i = 0; i < 20; i++) crack(g, r, r() * 512, r() * 512, 5, 14);
      break;
    case 'sand':
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgba(${r() < 0.5 ? '120,85,50' : '245,220,170'},0.25)`;
        g.fillRect(r() * 512, r() * 512, 20 + r() * 60, 2);
      }
      break;
    case 'void':
      g.lineWidth = 2;
      for (let i = 0; i < 10; i++) {
        g.strokeStyle = i % 2 ? 'rgba(180,100,255,0.9)' : 'rgba(110,255,170,0.8)';
        crack(g, r, r() * 512, r() * 512, 7, 18);
      }
      break;
  }
  return c;
}

/** Placeholder stone for pillars. Tiles horizontally. */
export function stoneTexture(style?: StoneStyle): THREE.Texture {
  const tex = new THREE.CanvasTexture(drawStone(style));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export type GroundKind = 'grass' | 'lava' | 'snow' | 'sand';

/** Seamless 512² ground texture for the terrain outside the arena wall. */
export function drawGround(kind: GroundKind): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const r = rng(31);
  // Draw something at (x, y) and at its wrapped copies so the texture tiles.
  const wrapped = (x: number, y: number, pad: number, fn: (x: number, y: number) => void) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const px = x + ox, py = y + oy;
      if (px > -pad && px < S + pad && py > -pad && py < S + pad) fn(px, py);
    }
  };
  switch (kind) {
    case 'grass':
      g.fillStyle = '#1e2a16';
      g.fillRect(0, 0, S, S);
      for (let i = 0; i < 40; i++) {
        const rad = 30 + r() * 70;
        const tone = r() < 0.5 ? 'rgba(40,62,28,0.6)' : 'rgba(22,34,18,0.6)';
        wrapped(r() * S, r() * S, rad, (x, y) => blob(g, x, y, rad, tone, 'rgba(30,45,22,0)'));
      }
      g.lineWidth = 1.5;
      for (let i = 0; i < 5000; i++) {
        const x = r() * S, y = r() * S, l = 4 + r() * 9, a = -Math.PI / 2 + (r() - 0.5) * 0.9;
        g.strokeStyle = `rgba(${40 + r() * 50},${70 + r() * 70},${25 + r() * 25},0.75)`;
        wrapped(x, y, 12, (px, py) => {
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          g.stroke();
        });
      }
      break;
    case 'lava':
      g.fillStyle = '#ff5a10';
      g.fillRect(0, 0, S, S);
      for (let i = 0; i < 30; i++) {
        const rad = 30 + r() * 60;
        wrapped(r() * S, r() * S, rad, (x, y) => blob(g, x, y, rad, 'rgba(255,200,90,0.8)', 'rgba(255,120,20,0)'));
      }
      // Cooling crust plates; the bright lava shows through the cracks between them.
      for (let i = 0; i < 70; i++) {
        const x = r() * S, y = r() * S, rad = 22 + r() * 34, rot = r() * Math.PI, sq = 0.6 + r() * 0.4;
        const shade = 22 + Math.floor(r() * 18);
        wrapped(x, y, rad, (px, py) => {
          g.fillStyle = `rgb(${shade + 8},${shade},${shade - 4})`;
          g.beginPath();
          g.ellipse(px, py, rad, rad * sq, rot, 0, Math.PI * 2);
          g.fill();
        });
      }
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgba(${10 + r() * 30},${8 + r() * 20},${8 + r() * 15},0.5)`;
        g.fillRect(r() * S, r() * S, 2, 2);
      }
      break;
    case 'snow':
      g.fillStyle = '#d7e2f0';
      g.fillRect(0, 0, S, S);
      for (let i = 0; i < 45; i++) {
        const rad = 30 + r() * 80;
        const tone = r() < 0.5 ? 'rgba(170,190,230,0.45)' : 'rgba(250,252,255,0.7)';
        wrapped(r() * S, r() * S, rad, (x, y) => blob(g, x, y, rad, tone, 'rgba(220,230,245,0)'));
      }
      for (let i = 0; i < 2500; i++) {
        g.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`;
        g.fillRect(r() * S, r() * S, 1.5, 1.5);
      }
      break;
    case 'sand':
      g.fillStyle = '#c49a5e';
      g.fillRect(0, 0, S, S);
      for (let i = 0; i < 40; i++) {
        const rad = 40 + r() * 80;
        const tone = r() < 0.5 ? 'rgba(220,180,120,0.55)' : 'rgba(160,115,65,0.4)';
        wrapped(r() * S, r() * S, rad, (x, y) => blob(g, x, y, rad, tone, 'rgba(200,160,100,0)'));
      }
      // Ripples: wavy bands that wrap horizontally.
      g.lineWidth = 3;
      for (let row = 0; row < 26; row++) {
        const y0 = (row / 26) * S + r() * 6;
        const phase = r() * Math.PI * 2;
        for (const [dy, col] of [[0, 'rgba(120,85,45,0.35)'], [3, 'rgba(240,210,160,0.4)']] as const) {
          g.strokeStyle = col;
          g.beginPath();
          for (let x = 0; x <= S; x += 8) {
            const y = y0 + dy + Math.sin((x / S) * Math.PI * 6 + phase) * 5;
            if (x === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      break;
  }
  return c;
}

const EMPTY = document.createElement('canvas');
EMPTY.width = EMPTY.height = 1;

/**
 * A canvas texture whose pixels can be dropped (GPU and CPU) while it is unused and redrawn
 * deterministically when it is needed again. Keeps memory flat across environment switches.
 */
export class RegenTexture {
  readonly texture: THREE.CanvasTexture;
  private live = true;

  constructor(private readonly draw: () => HTMLCanvasElement, setup?: (t: THREE.Texture) => void) {
    this.texture = new THREE.CanvasTexture(draw());
    this.texture.colorSpace = THREE.SRGBColorSpace;
    setup?.(this.texture);
  }

  acquire(): THREE.CanvasTexture {
    if (!this.live) {
      this.live = true;
      this.texture.image = this.draw();
      this.texture.needsUpdate = true;
    }
    return this.texture;
  }

  release(): void {
    if (!this.live) return;
    this.live = false;
    this.texture.dispose();
    this.texture.image = EMPTY;
  }
}
