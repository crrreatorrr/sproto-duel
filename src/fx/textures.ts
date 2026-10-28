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
  /**
   * Base layout: concentric flagstones with a rune circle (default), a city intersection
   * ('plaza': `stone` asphalt, `gap` sidewalk concrete, `rune` crosswalk paint, `glyph` lane
   * paint) or office carpet tiles ('carpet': `stone` carpet, `rune` emblem glow, `glyph` emblem
   * lines, `mark` floor tape).
   */
  pattern?: 'flagstones' | 'plaza' | 'carpet';
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
  if (style.pattern === 'plaza') return drawPlazaFloor(style);
  if (style.pattern === 'carpet') return drawCarpetFloor(style);
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
  /** 'graffiti': spray-paint blocks and tags over concrete; 'office': beige wall, fabric band, baseboard. */
  extras?: 'moss' | 'veins' | 'frost' | 'sand' | 'void' | 'graffiti' | 'office';
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
    case 'graffiti':
      graffiti(g, r, 512, 512, 14);
      break;
    case 'office': {
      // Beige drywall over a blue-grey fabric band and a brushed-metal baseboard (a 1.4 m wall).
      g.fillStyle = style.bg;
      g.fillRect(0, 0, 512, 290);
      for (let i = 0; i < 40; i++) blob(g, r() * 512, r() * 290, 20 + r() * 60, 'rgba(255,250,235,0.12)', 'rgba(255,250,235,0)');
      g.fillStyle = '#5c6e86';
      g.fillRect(0, 290, 512, 160);
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(130,150,180,0.35)' : 'rgba(40,50,66,0.35)';
        g.fillRect(r() * 512, 290 + r() * 160, 2, 2);
      }
      g.fillStyle = '#9aa0a6';
      g.fillRect(0, 284, 512, 7);
      g.fillRect(0, 448, 512, 6);
      const base = g.createLinearGradient(0, 454, 0, 512);
      base.addColorStop(0, '#7a7e84');
      base.addColorStop(1, '#4e5258');
      g.fillStyle = base;
      g.fillRect(0, 454, 512, 58);
      break;
    }
  }
  return c;
}

const SPRAY = ['255,70,170', '40,230,215', '255,200,40', '170,90,255', '255,120,50'];

/** Spray-paint colour blocks, drips and tags (city walls, columns and floor). */
function graffiti(g: CanvasRenderingContext2D, r: Rand, w: number, h: number, count: number, alpha = 0.78): void {
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const col = SPRAY[Math.floor(r() * SPRAY.length)];
    const x = r() * w, y = r() * h;
    if (r() < 0.45) {
      // Colour block with drips.
      const bw = 30 + r() * 90, bh = 20 + r() * 50;
      g.fillStyle = `rgba(${col},${alpha})`;
      g.beginPath();
      g.ellipse(x, y, bw / 2, bh / 2, (r() - 0.5) * 0.5, 0, Math.PI * 2);
      g.fill();
      for (let d = 0; d < 3; d++) g.fillRect(x - bw / 3 + r() * bw * 0.6, y, 3, bh / 2 + r() * 30);
    } else {
      // A looping tag.
      g.strokeStyle = `rgba(${col},${alpha})`;
      g.lineWidth = 4 + r() * 4;
      g.beginPath();
      g.moveTo(x, y);
      let px = x, py = y;
      for (let k = 0; k < 6; k++) {
        const nx = px + 10 + r() * 16, ny = y + (r() - 0.5) * 30;
        g.quadraticCurveTo(px + (r() - 0.3) * 30, py - 20 - r() * 20, nx, ny);
        px = nx;
        py = ny;
      }
      g.stroke();
    }
  }
  g.lineCap = 'butt';
}

/**
 * City floor: an intersection clipped to the arena disc. Asphalt roads along x and z (the spawn
 * line runs down one), concrete sidewalk corners with curbs, zebra crosswalks, lane paint, a
 * manhole at the centre, oil stains, cracks, sidewalk stars and spray tags.
 */
function drawPlazaFloor(style: FloorStyle): HTMLCanvasElement {
  const size = 2048;
  const [c, g] = canvas(size);
  const r = rng(11);
  const cx = size / 2;
  const m = cx / 30.6; // pixels per metre (the floor disc is 30.6 m)
  const road = 6.2 * m; // half width of each road
  const curbR = 2.4 * m;
  g.fillStyle = `rgb(${style.stone[0]},${style.stone[1]},${style.stone[2]})`;
  g.fillRect(0, 0, size, size);
  // Asphalt grit.
  const gr = style.grit;
  for (let i = 0; i < 30000; i++) {
    const v = Math.floor(r() * style.gritRange);
    g.fillStyle = `rgba(${gr[0] + v},${gr[1] + v},${gr[2] + v},${style.gritAlpha})`;
    g.fillRect(r() * size, r() * size, 2, 2);
  }
  // Sidewalk corners: concrete slabs inside a rounded curb.
  const slab = 1.6 * m;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx > 0 ? cx + road : 0, y = sy > 0 ? cx + road : 0, w = cx - road, h = cx - road;
      // Round the corner nearest the centre: [top-left, top-right, bottom-right, bottom-left].
      const radii = sx > 0 ? (sy > 0 ? [curbR, 0, 0, 0] : [0, 0, 0, curbR]) : (sy > 0 ? [0, curbR, 0, 0] : [0, 0, curbR, 0]);
      g.save();
      g.beginPath();
      g.roundRect(x, y, w, h, radii);
      g.clip();
      g.fillStyle = style.gap;
      g.fillRect(x, y, w, h);
      for (let yy = y; yy < y + h; yy += slab) {
        for (let xx = x; xx < x + w; xx += slab) {
          const v = Math.floor(r() * 18) - 9;
          g.fillStyle = `rgb(${126 + v},${121 + v},${114 + v})`;
          g.fillRect(xx + 2, yy + 2, slab - 4, slab - 4);
        }
      }
      g.restore();
      g.strokeStyle = 'rgba(205,200,190,0.95)';
      g.lineWidth = 0.22 * m;
      g.beginPath();
      g.roundRect(x, y, w, h, radii);
      g.stroke();
    }
  }
  // Crosswalks on each arm, a stop line behind each, lane paint beyond.
  const along = (arm: number, a: number, b: number, w0: number, w1: number) => {
    const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][arm];
    const xA = cx + dx * a, yA = cx + dy * a, xB = cx + dx * b, yB = cx + dy * b;
    if (dx) g.fillRect(Math.min(xA, xB), cx + w0, Math.abs(xB - xA), w1 - w0);
    else g.fillRect(cx + w0, Math.min(yA, yB), w1 - w0, Math.abs(yB - yA));
  };
  const cwA = road + 0.6 * m, cwB = cwA + 3.2 * m;
  for (let arm = 0; arm < 4; arm++) {
    g.fillStyle = style.rune;
    const bar = 0.55 * m;
    for (let w = -road + 0.4 * m; w + bar < road - 0.3 * m; w += bar * 2) along(arm, cwA, cwB, w, w + bar);
    along(arm, cwB + 0.5 * m, cwB + 0.9 * m, 0.15 * m, road - 0.3 * m); // stop line
    g.fillStyle = style.glyph;
    along(arm, cwB + 0.6 * m, cx, -0.28 * m, -0.12 * m);
    along(arm, cwB + 0.6 * m, cx, 0.12 * m, 0.28 * m);
    g.fillStyle = style.rune;
    for (let d = cwB + 2 * m; d < cx; d += 4.5 * m) {
      along(arm, d, d + 2.4 * m, road / 2 - 0.08 * m, road / 2 + 0.08 * m);
      along(arm, d, d + 2.4 * m, -road / 2 - 0.08 * m, -road / 2 + 0.08 * m);
    }
  }
  // Worn paint: dark flecks everywhere.
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(40,38,40,${0.3 + r() * 0.4})`;
    g.fillRect(r() * size, r() * size, 2 + r() * 3, 2 + r() * 3);
  }
  // Oil stains, tyre marks, cracks.
  for (let i = 0; i < 70; i++) {
    const [x, y] = inDisc(r, size, 0, 0.95, 0.6);
    blob(g, x, y, 14 + r() * 50, 'rgba(18,16,20,0.45)', 'rgba(18,16,20,0)');
  }
  g.lineWidth = 0.25 * m;
  g.strokeStyle = 'rgba(20,18,20,0.3)';
  for (let i = 0; i < 10; i++) {
    const rr = (3 + r() * 6) * m;
    const a = r() * Math.PI * 2;
    g.beginPath();
    g.arc(cx + Math.cos(a) * rr * 0.6, cx + Math.sin(a) * rr * 0.6, rr, a, a + 0.6 + r());
    g.stroke();
  }
  g.strokeStyle = 'rgba(25,22,24,0.7)';
  g.lineWidth = 2;
  for (let i = 0; i < 60; i++) {
    const [x, y] = inDisc(r, size);
    crack(g, r, x, y, 5 + Math.floor(r() * 6), 22);
  }
  // Sidewalk stars (pink terrazzo, brass rim) along the corners.
  for (let i = 0; i < 16; i++) {
    const sx = r() < 0.5 ? -1 : 1, sy = r() < 0.5 ? -1 : 1;
    const d = (9 + r() * 14) * m;
    const side = r() < 0.5;
    const x = cx + sx * (side ? road + 2.2 * m : d), y = cx + sy * (side ? d : road + 2.2 * m);
    if (Math.hypot(x - cx, y - cx) > cx * 0.92) continue;
    g.fillStyle = '#3a3438';
    g.fillRect(x - 0.8 * m, y - 0.8 * m, 1.6 * m, 1.6 * m);
    g.fillStyle = 'rgba(232,120,160,0.95)';
    g.strokeStyle = 'rgba(214,170,80,0.95)';
    g.lineWidth = 3;
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = (k % 2 ? 0.28 : 0.65) * m;
      if (k) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.stroke();
  }
  // Spray tags and gum.
  graffiti(g, r, size, size, 26, 0.5);
  g.fillStyle = 'rgba(40,36,40,0.35)';
  for (let i = 0; i < 900; i++) {
    const [x, y] = inDisc(r, size);
    const s = 3 + r() * 5;
    g.fillRect(x, y, s, s);
  }
  // Manhole cover in the middle.
  g.fillStyle = '#2c2422';
  g.beginPath();
  g.arc(cx, cx, 0.75 * m, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(120,96,80,0.9)';
  g.lineWidth = 4;
  g.stroke();
  g.lineWidth = 2;
  const mr = 0.7 * m;
  g.beginPath();
  for (let k = -5; k <= 5; k++) {
    const o = (k / 6) * mr;
    const h = Math.sqrt(Math.max(0, mr * mr - o * o));
    g.moveTo(cx + o, cx - h);
    g.lineTo(cx + o, cx + h);
    g.moveTo(cx - h, cx + o);
    g.lineTo(cx + h, cx + o);
  }
  g.stroke();
  return c;
}

/** Carpet tiles with the weave turned on alternate tiles. Shared by the floor and the outer ground. */
function carpetTiles(g: CanvasRenderingContext2D, r: Rand, size: number, tile: number, base: RGB, range: number): void {
  for (let y = 0, ty = 0; y < size; y += tile, ty++) {
    for (let x = 0, tx = 0; x < size; x += tile, tx++) {
      const v = Math.floor(r() * range) - range / 2;
      g.fillStyle = `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`;
      g.fillRect(x, y, tile, tile);
      g.strokeStyle = 'rgba(20,24,32,0.22)';
      g.lineWidth = 1;
      const turn = (tx + ty) % 2 === 0;
      g.beginPath();
      for (let k = 2; k < tile; k += 3) {
        if (turn) {
          g.moveTo(x + k, y + 1);
          g.lineTo(x + k, y + tile - 1);
        } else {
          g.moveTo(x + 1, y + k);
          g.lineTo(x + tile - 1, y + k);
        }
      }
      g.stroke();
      g.strokeStyle = 'rgba(16,18,24,0.22)';
      g.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
    }
  }
}

/**
 * Office floor: grey-blue carpet tiles, worn walkways and coffee stains, with a fictional agency
 * emblem (an eye in a triangle in a ring, glowing green) in the centre and tape on the spawn marks.
 */
function drawCarpetFloor(style: FloorStyle): HTMLCanvasElement {
  const size = 2048;
  const [c, g] = canvas(size);
  const r = rng(23);
  const cx = size / 2;
  const m = cx / 30.6;
  carpetTiles(g, r, size, Math.round(0.9 * m), style.stone, style.stoneRange);
  const gr = style.grit;
  for (let i = 0; i < 26000; i++) {
    const v = Math.floor(r() * style.gritRange);
    g.fillStyle = `rgba(${gr[0] + v},${gr[1] + v},${gr[2] + v},${style.gritAlpha})`;
    g.fillRect(r() * size, r() * size, 2, 2);
  }
  // Worn walkways (lighter) and coffee stains.
  for (let i = 0; i < 90; i++) {
    const [x, y] = inDisc(r, size, 0.1, 1, 0.5);
    blob(g, x, y, 40 + r() * 120, 'rgba(150,160,170,0.12)', 'rgba(150,160,170,0)');
  }
  for (let i = 0; i < 26; i++) {
    const [x, y] = inDisc(r, size, 0.2, 0.95, 0.5);
    const rr = 8 + r() * 18;
    g.strokeStyle = `rgba(90,62,36,${0.35 + r() * 0.3})`;
    g.lineWidth = 2 + r() * 3;
    g.beginPath();
    g.arc(x, y, rr, r() * 6, r() * 6 + 4 + r() * 2);
    g.stroke();
    if (r() < 0.5) blob(g, x + rr, y, rr * 1.2, 'rgba(80,56,30,0.35)', 'rgba(80,56,30,0)');
  }

  // The emblem: rings, lettering, triangle, rays and an eye. Green parts glow (bright texels).
  const R = 7.2 * m;
  const glow = (w: number, path: () => void) => {
    g.strokeStyle = style.rune;
    g.lineWidth = w * 2.6;
    g.globalAlpha = 0.25;
    path();
    g.stroke();
    g.globalAlpha = 1;
    g.lineWidth = w;
    path();
    g.stroke();
  };
  const circle = (rad: number, y = cx) => () => {
    g.beginPath();
    g.arc(cx, y, rad, 0, Math.PI * 2);
  };
  g.strokeStyle = style.glyph;
  g.lineWidth = 0.35 * m;
  circle(R)();
  g.stroke();
  g.lineWidth = 0.12 * m;
  circle(R + 0.9 * m)();
  g.stroke();
  glow(0.14 * m, circle(R - 0.55 * m));
  g.fillStyle = style.glyph;
  g.font = `bold ${Math.round(0.55 * m)}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const text = 'BUREAU OF GENERAL OVERSIGHT ★ EST. MCMXLVII ★ ';
  const tr = R + 0.47 * m;
  for (let i = 0; i < text.length; i++) {
    const a = (i / text.length) * Math.PI * 2 - Math.PI / 2;
    g.save();
    g.translate(cx + Math.cos(a) * tr, cx + Math.sin(a) * tr);
    g.rotate(a + Math.PI / 2);
    g.fillText(text[i], 0, 0);
    g.restore();
  }
  g.strokeStyle = style.glyph;
  g.lineWidth = 0.3 * m;
  g.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    const x = cx + Math.cos(a) * (R - 0.9 * m), y = cx + Math.sin(a) * (R - 0.9 * m);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
  g.stroke();
  const ey = cx + 0.4 * m;
  glow(0.08 * m, () => {
    g.beginPath();
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      g.moveTo(cx + Math.cos(a) * 1.9 * m, ey + Math.sin(a) * 1.9 * m);
      g.lineTo(cx + Math.cos(a) * 2.9 * m, ey + Math.sin(a) * 2.9 * m);
    }
  });
  g.fillStyle = 'rgba(200,204,196,0.9)';
  g.beginPath();
  g.moveTo(cx - 2.4 * m, ey);
  g.quadraticCurveTo(cx, ey - 2.0 * m, cx + 2.4 * m, ey);
  g.quadraticCurveTo(cx, ey + 2.0 * m, cx - 2.4 * m, ey);
  g.fill();
  g.strokeStyle = style.glyph;
  g.lineWidth = 0.14 * m;
  g.stroke();
  g.fillStyle = 'rgba(60,200,120,0.95)';
  circle(0.75 * m, ey)();
  g.fill();
  glow(0.1 * m, circle(0.78 * m, ey));
  g.fillStyle = '#121614';
  circle(0.36 * m, ey)();
  g.fill();

  // Floor tape on the spawn marks (z = +-8 m).
  g.strokeStyle = style.mark;
  g.lineWidth = 0.14 * m;
  for (const sgn of [-1, 1]) g.strokeRect(cx - 0.8 * m, cx + sgn * 8 * m - 0.8 * m, 1.6 * m, 1.6 * m);
  return c;
}

/** Placeholder stone for pillars. Tiles horizontally. */
export function stoneTexture(style?: StoneStyle): THREE.Texture {
  const tex = new THREE.CanvasTexture(drawStone(style));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export type GroundKind = 'grass' | 'lava' | 'snow' | 'sand' | 'asphalt' | 'carpet';

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
    case 'asphalt':
      g.fillStyle = '#383436';
      g.fillRect(0, 0, S, S);
      for (let i = 0; i < 30; i++) {
        const rad = 30 + r() * 70;
        const tone = r() < 0.5 ? 'rgba(70,64,66,0.5)' : 'rgba(22,20,22,0.45)';
        wrapped(r() * S, r() * S, rad, (x, y) => blob(g, x, y, rad, tone, 'rgba(40,38,40,0)'));
      }
      for (let i = 0; i < 9000; i++) {
        const v = Math.floor(r() * 60);
        g.fillStyle = `rgba(${40 + v},${38 + v},${40 + v},0.4)`;
        g.fillRect(r() * S, r() * S, 2, 2);
      }
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(16,14,16,0.6)';
      for (let i = 0; i < 12; i++) crack(g, r, 60 + r() * (S - 120), 60 + r() * (S - 120), 5, 12);
      break;
    case 'carpet':
      carpetTiles(g, r, S, 32, [72, 80, 94], 10);
      break;
  }
  return c;
}

/** 512² office ceiling (8 x 8 acoustic tiles, two fluorescent troffers). `glowOnly`: just the lit panels. */
export function drawCeiling(glowOnly = false): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const r = rng(41);
  const tile = S / 8;
  g.fillStyle = glowOnly ? '#000' : '#8e928c';
  g.fillRect(0, 0, S, S);
  if (!glowOnly) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = Math.floor(r() * 14);
        g.fillStyle = `rgb(${190 + v},${192 + v},${184 + v})`;
        g.fillRect(x * tile + 2, y * tile + 2, tile - 4, tile - 4);
        g.fillStyle = 'rgba(120,124,116,0.35)';
        for (let k = 0; k < 60; k++) g.fillRect(x * tile + 3 + r() * (tile - 6), y * tile + 3 + r() * (tile - 6), 1.5, 1.5);
      }
    }
  }
  for (const [tx, ty] of [[1, 1], [5, 5]]) {
    const x = tx * tile + 3, y = ty * tile + 3, w = 2 * tile - 6, h = tile - 6;
    g.fillStyle = glowOnly ? '#000' : '#d8dcd6';
    g.fillRect(x, y, w, h);
    const grad = g.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#d4f0da');
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(1, '#d4f0da');
    g.fillStyle = grad;
    g.fillRect(x + 6, y + 6, w - 12, h - 12);
    g.fillStyle = glowOnly ? 'rgba(0,0,0,0.35)' : 'rgba(150,160,150,0.5)';
    for (let k = 1; k < 4; k++) g.fillRect(x + 6, y + (h * k) / 4 - 1, w - 12, 2);
  }
  return c;
}

/**
 * 512² office wall section (mapped once over the 12 m room height): beige wall, a window with
 * blinds lit from outside, and a baseboard. `glowOnly`: just the daylight through the blinds.
 */
export function drawOfficeWall(glowOnly = false): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const r = rng(43);
  g.fillStyle = glowOnly ? '#000' : '#c4b896';
  g.fillRect(0, 0, S, S);
  if (!glowOnly) {
    for (let i = 0; i < 30; i++) blob(g, r() * S, r() * S, 30 + r() * 60, 'rgba(255,248,230,0.1)', 'rgba(255,248,230,0)');
    g.fillStyle = '#54585c';
    g.fillRect(0, S - 14, S, 14);
    g.fillStyle = 'rgba(110,100,80,0.3)';
    g.fillRect(0, 0, 8, S);
  }
  const x0 = 70, x1 = S - 70, y0 = S * 0.5, y1 = S * 0.84;
  g.fillStyle = glowOnly ? '#000' : '#62685e';
  g.fillRect(x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16);
  const sky = g.createLinearGradient(0, y0, 0, y1);
  sky.addColorStop(0, '#eef6ff');
  sky.addColorStop(1, '#bcd2dc');
  g.fillStyle = sky;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  for (let y = y0; y < y0 + (y1 - y0) * 0.7; y += 6) {
    g.fillStyle = glowOnly ? 'rgba(0,0,0,0.6)' : 'rgba(204,200,186,0.95)';
    g.fillRect(x0, y, x1 - x0, 3.5);
  }
  g.fillStyle = glowOnly ? '#000' : '#565a58';
  g.fillRect((x0 + x1) / 2 - 3, y0, 6, y1 - y0);
  return c;
}

/** 256² building facade (4 x 4 windows), some lit warm, teal or pink. `glowOnly`: just the lit windows. */
export function drawFacade(glowOnly = false): HTMLCanvasElement {
  const S = 256;
  const [c, g] = canvas(S);
  const r = rng(47);
  g.fillStyle = glowOnly ? '#000' : '#3c3038';
  g.fillRect(0, 0, S, S);
  if (!glowOnly) {
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = `rgba(${90 + r() * 40},${70 + r() * 30},${80 + r() * 30},0.25)`;
      g.fillRect(r() * S, r() * S, 2, 2);
    }
  }
  const cell = S / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const lit = r();
      const wx = x * cell + 14, wy = y * cell + 16, ww = cell - 28, wh = cell - 26;
      let col = glowOnly ? '#000' : '#1a1820';
      if (lit < 0.17) col = '#ffb866';
      else if (lit < 0.21) col = '#7ff0ff';
      else if (lit < 0.24) col = '#ff7ac8';
      g.fillStyle = col;
      g.fillRect(wx, wy, ww, wh);
      if (!glowOnly) {
        g.fillStyle = 'rgba(20,16,24,0.6)';
        g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      }
    }
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
