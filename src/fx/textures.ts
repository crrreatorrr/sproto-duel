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

/** Placeholder arena floor: concentric flagstones with a rune circle. Used when no floor texture is supplied. */
export function arenaFloorTexture(): THREE.Texture {
  const size = 2048;
  const [c, g] = canvas(size);
  const r = rng(7);
  const cx = size / 2;
  g.fillStyle = '#3a3742';
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
      const shade = 48 + Math.floor(r() * 22);
      g.fillStyle = `rgb(${shade},${shade - 3},${shade + 8})`;
      g.beginPath();
      g.arc(cx, cx, r1 - 3, a0 + 0.004, a1 - 0.004);
      g.arc(cx, cx, Math.max(0, r0 + 3), a1 - 0.004, a0 + 0.004, true);
      g.closePath();
      g.fill();
    }
  }

  // Grit.
  for (let i = 0; i < 26000; i++) {
    const v = Math.floor(r() * 50) + 30;
    g.fillStyle = `rgba(${v},${v},${v + 10},0.25)`;
    g.fillRect(r() * size, r() * size, 2, 2);
  }

  // Rune circle around the middle of the arena.
  g.strokeStyle = 'rgba(120,170,255,0.55)';
  g.lineWidth = 6;
  for (const rr of [0.18, 0.21, 0.6, 0.625]) {
    g.beginPath();
    g.arc(cx, cx, cx * rr, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = 'bold 34px serif';
  g.fillStyle = 'rgba(140,190,255,0.6)';
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
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx, cx * 0.22);
  g.lineTo(cx, cx * 1.78);
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Placeholder stone for pillars. Tiles horizontally. */
export function stoneTexture(): THREE.Texture {
  const [c, g] = canvas(512);
  const r = rng(19);
  g.fillStyle = '#6b6672';
  g.fillRect(0, 0, 512, 512);
  const rows = 8;
  for (let y = 0; y < rows; y++) {
    const off = (y % 2) * 64;
    for (let x = -1; x < 4; x++) {
      const shade = 90 + Math.floor(r() * 30);
      g.fillStyle = `rgb(${shade},${shade - 4},${shade + 6})`;
      g.fillRect(x * 128 + off + 3, y * 64 + 3, 122, 58);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const v = Math.floor(r() * 60) + 40;
    g.fillStyle = `rgba(${v},${v},${v},0.25)`;
    g.fillRect(r() * 512, r() * 512, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
