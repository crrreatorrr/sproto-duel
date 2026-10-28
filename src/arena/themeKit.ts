import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { RegenTexture, drawCeiling, drawFacade, drawOfficeWall } from '../fx/textures';
import type { ObstacleKind } from './Pillar';
import type { ArenaTheme } from './themes';

const A = CONFIG.arena;
const P = A.pillars;
const C = A.cubicles;
/** Office room around the arena: wall radius (the ceiling reaches a little past it). */
const ROOM_RADIUS = 58;

/** Deterministic pseudo-random so placeholder layouts are identical every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Translate (and optionally rotate) a geometry in place. */
function at(geo: THREE.BufferGeometry, y: number, x = 0, z = 0, rotY = 0): THREE.BufferGeometry {
  if (rotY) geo.rotateY(rotY);
  geo.translate(x, y, z);
  return geo;
}

/** Merge parts into one geometry (one draw call); mixes indexed and non-indexed parts. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyFlat = parts.some((g) => !g.index);
  const list = anyFlat ? parts.map((g) => (g.index ? g.toNonIndexed() : g)) : parts;
  const out = mergeGeometries(list, false);
  if (!out) throw new Error('themeKit merge: parts have different attributes');
  for (const g of parts) g.dispose();
  if (anyFlat) for (const g of list) g.dispose();
  return out;
}

/** Bake a flat vertex colour (glow parts share one vertex-coloured material). */
function tint(geo: THREE.BufferGeometry, hex: number, intensity: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex).multiplyScalar(intensity);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** A box with a flat vertex colour (times `k`), centred at (x, y, z) and turned by `rotY`. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, k = 1, rotY = 0): THREE.BufferGeometry {
  return at(tint(new THREE.BoxGeometry(w, h, d), hex, k), y, x, z, rotY);
}

/** A vertex-coloured cylinder centred at (x, y, z). */
function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, hex: number, k = 1): THREE.BufferGeometry {
  return at(tint(new THREE.CylinderGeometry(rt, rb, h, seg), hex, k), y, x, z);
}

/** A vertex-coloured box with a jagged broken top (stumps), its base on y = y0. */
function brokenBox(w: number, h: number, d: number, x: number, y0: number, z: number, hex: number, seed: number, rotY = 0, jagAmount = 0.22): THREE.BufferGeometry {
  const g = jag(new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w * 5)), 1, Math.max(1, Math.round(d * 5))), h / 2 - 0.01, jagAmount, seed);
  return at(tint(g, hex, 1), y0 + h / 2, x, z, rotY);
}

/** Map every UV of a geometry to one texel (a solid region of an atlas texture). */
function flatUV(geo: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return geo;
}

/** Position-hashed noise in [-1, 1]: seam duplicates move together, so there are no cracks. */
function hash3(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(Math.round(x * 97) * 12.9898 + Math.round(y * 97) * 78.233 + Math.round(z * 97) * 37.719 + seed) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Jagged broken top for stumps. */
function jag(geo: THREE.BufferGeometry, above: number, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > above) pos.setY(i, y + (hash3(pos.getX(i), 0, pos.getZ(i), seed) * 0.5 + 0.35) * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Gnarled, organic profile (grove columns). */
function gnarl(geo: THREE.BufferGeometry, amount: number): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + amount * (Math.sin(y * 2.3 + a * 3) * 0.6 + Math.sin(y * 5.1 - a * 5) * 0.4);
    pos.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Standard materials are cloned per pillar so damage tint and hit glow stay per pillar. */
  perPillar: boolean;
  shadow: boolean;
}

export interface PillarParts {
  whole: THREE.Object3D;
  stump: THREE.Object3D;
}

/**
 * Shared geometry and template materials for one theme's placeholder pillars, the props outside
 * the wall and the terrain dressing. Built once per theme on first use; `release()` frees the GPU
 * copies while the theme is inactive (they re-upload on next use).
 */
export class ThemeKit {
  /** Set pieces around the wall. A theme prop GLB replaces these. */
  readonly props = new THREE.Group();
  /** Terrain that stays even with a prop GLB (dunes, the floating island's underside, city blocks, the office room). */
  readonly terrain = new THREE.Group();
  /** Standing parts per obstacle kind ('pillar' for ring layouts; cubicle, cabinet, copier, cooler in the office). */
  private readonly wholes = new Map<ObstacleKind, Part[]>();
  /** Stump variants per obstacle kind. */
  private readonly stumpSets = new Map<ObstacleKind, Part[][]>();
  /** The part list `addPart` currently fills. */
  private building: Part[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  /** Kit canvases (facades, ceiling, office walls): dropped while inactive, redrawn on reuse. */
  private readonly textures: RegenTexture[] = [];
  /** Every material that samples the theme stone texture (templates and per-pillar clones). */
  private readonly stoneUsers: THREE.MeshStandardMaterial[] = [];
  /** Office room walls (hidden while a sky panorama shows the room instead). */
  private roomWalls: THREE.Object3D | null = null;
  private readonly spin: number;

  constructor(readonly theme: ArenaTheme, private stone: THREE.Texture) {
    if (theme.layout === 'cubicles') {
      this.buildOfficeCover();
    } else {
      this.buildPillar();
      this.buildStumps();
    }
    this.buildProps();
    this.spin = theme.props.style === 'asteroids' ? 0.012 : 0;
    this.props.name = `props:${theme.id}`;
    this.terrain.name = `terrain:${theme.id}`;
  }

  /** Obstacle kinds this kit can build. */
  get kinds(): ObstacleKind[] {
    return [...this.wholes.keys()];
  }

  /** One placeholder obstacle: shared geometry, its own copies of tintable materials. */
  makePillar(kind: ObstacleKind = 'pillar'): THREE.Object3D {
    const g = new THREE.Group();
    const parts = this.wholes.get(kind) ?? this.wholes.values().next().value ?? [];
    for (const p of parts) {
      let mat = p.material;
      if (p.perPillar) {
        mat = p.material.clone();
        if ((mat as THREE.MeshStandardMaterial).map === this.stone) this.stoneUsers.push(mat as THREE.MeshStandardMaterial);
      }
      const m = new THREE.Mesh(p.geometry, mat);
      m.castShadow = p.shadow;
      m.receiveShadow = p.shadow;
      g.add(m);
    }
    return g;
  }

  makeStump(index: number, kind: ObstacleKind = 'pillar'): THREE.Object3D {
    const sets = this.stumpSets.get(kind) ?? this.stumpSets.values().next().value ?? [[]];
    const parts = sets[index % sets.length];
    const g = new THREE.Group();
    for (const p of parts) {
      const m = new THREE.Mesh(p.geometry, p.material);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    return g;
  }

  /** Show or hide the office room walls (a sky panorama of the room replaces them). */
  setRoomWalls(visible: boolean): void {
    if (this.roomWalls) this.roomWalls.visible = visible;
  }

  /** Redraw kit canvases dropped by `release()` (the theme is about to show again). */
  acquire(): void {
    for (const t of this.textures) t.acquire();
  }

  /** Swap in a loaded stone texture (or back to the procedural one) everywhere it is sampled. */
  setStone(tex: THREE.Texture): void {
    if (tex === this.stone) return;
    this.stone = tex;
    for (const m of this.stoneUsers) {
      m.map = tex;
      m.needsUpdate = true;
    }
  }

  update(dt: number): void {
    if (this.spin) this.props.rotation.y += dt * this.spin;
  }

  /** Free GPU buffers while the theme is inactive. */
  release(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.instanced) m.dispose();
    for (const t of this.textures) t.release();
  }

  /** A kit canvas texture (tiling), released with the kit. */
  private regen(draw: () => HTMLCanvasElement, repeatU: number, repeatV: number): THREE.Texture {
    const t = new RegenTexture(draw, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeatU, repeatV);
      tex.anisotropy = 4;
    });
    this.textures.push(t);
    return t.texture;
  }

  // ------------------------------------------------------------------ pillars

  private standard(params: THREE.MeshStandardMaterialParameters, usesStone = false): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(usesStone ? { ...params, map: this.stone } : params);
    if (usesStone) this.stoneUsers.push(m);
    return m;
  }

  private glowMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  }

  private addPart(geometry: THREE.BufferGeometry, material: THREE.Material, perPillar: boolean, shadow = true): void {
    this.geometries.push(geometry);
    this.building.push({ geometry, material, perPillar, shadow });
  }

  /** Start filling the standing parts of `kind`. */
  private beginWhole(kind: ObstacleKind): void {
    this.building = [];
    this.wholes.set(kind, this.building);
  }

  /** Add one stump variant of `kind` (a single merged, shared-material part). */
  private addStump(kind: ObstacleKind, parts: Part[]): void {
    for (const p of parts) this.geometries.push(p.geometry);
    let sets = this.stumpSets.get(kind);
    if (!sets) this.stumpSets.set(kind, (sets = []));
    sets.push(parts);
  }

  private buildPillar(): void {
    const t = this.theme.pillar;
    const r = P.radius;
    const h = P.height;
    this.beginWhole('pillar');
    switch (t.style) {
      case 'cubicle': // a cubicle look on a ring layout: fall back to the plain column
      case 'column': {
        // The original moonlit column: base, shaft and capital in one draw call plus a rune band.
        const stone = merge([
          at(new THREE.CylinderGeometry(r * 1.3, r * 1.4, 0.45, 14), 0.225),
          at(new THREE.CylinderGeometry(r * 0.92, r, h - 0.9, 14, 4), h / 2),
          at(new THREE.CylinderGeometry(r * 1.3, r * 1.05, 0.45, 14), h - 0.225),
        ]);
        this.addPart(stone, this.standard({ roughness: 0.9, color: t.color }, true), true);
        const band = new THREE.TorusGeometry(r * 1.05, 0.03, 6, 32);
        band.rotateX(Math.PI / 2);
        band.translate(0, h * 0.62, 0);
        this.addPart(band, new THREE.MeshBasicMaterial({ color: new THREE.Color(t.accent).multiplyScalar(2), toneMapped: false }), false, false);
        break;
      }
      case 'grove': {
        // Mossy standing column wound with a glowing vine, crowned with leaves.
        const stone = merge([
          at(new THREE.CylinderGeometry(r * 1.15, r * 1.5, 0.6, 12), 0.3),
          gnarl(at(new THREE.CylinderGeometry(r * 0.9, r * 1.04, h - 0.75, 12, 8), 0.3 + (h - 0.75) / 2), 0.07),
          at(new THREE.CylinderGeometry(r * 1.12, r * 0.95, 0.4, 12), h - 0.25),
        ]);
        this.addPart(stone, this.standard({ roughness: 1, color: t.color }, true), true);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 48; i++) {
          const k = i / 48;
          const a = k * Math.PI * 2 * 2.3;
          const rr = r * (1.04 + 0.05 * Math.sin(k * 20));
          pts.push(new THREE.Vector3(Math.cos(a) * rr, 0.5 + k * (h - 1.0), Math.sin(a) * rr));
        }
        const vine = tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.035, 5), t.accent, 1.0);
        const blossoms = [0.2, 0.45, 0.7, 0.9].map((k, i) => {
          const p = pts[Math.round(k * 48)];
          return tint(at(new THREE.IcosahedronGeometry(0.1, 0), p.y, p.x * 1.05, p.z * 1.05), i % 2 ? 0xfff0a0 : t.accent, 1.8);
        });
        this.addPart(merge([vine, ...blossoms]), this.glowMaterial(), false, false);
        const leaves = merge([
          at(new THREE.IcosahedronGeometry(1.05, 0), h + 0.35, 0.25, 0.1),
          at(new THREE.IcosahedronGeometry(0.85, 0), h + 0.2, -0.45, 0.35),
          at(new THREE.IcosahedronGeometry(0.75, 0), h + 0.85, -0.1, -0.35),
        ]);
        this.addPart(leaves, this.standard({ color: t.trim ?? 0x2f5a2a, roughness: 0.9, flatShading: true }), true);
        break;
      }
      case 'basalt': {
        // Hexagonal basalt column with a stepped broken top and glowing magma seams.
        const stone = merge([
          at(new THREE.CylinderGeometry(r * 1.28, r * 1.45, 0.4, 6), 0.2, 0, 0, Math.PI / 6),
          at(new THREE.CylinderGeometry(r * 1.0, r * 1.08, h * 0.8, 6), h * 0.4),
          at(new THREE.CylinderGeometry(r * 0.6, r * 0.64, h * 0.3, 6), h * 0.8 + h * 0.15 - 0.1, r * 0.3, 0.1),
        ]);
        this.addPart(stone, this.standard({ roughness: 0.85, color: t.color, flatShading: true }, true), true);
        const seam = (y: number, rr: number) => tint(at(new THREE.CylinderGeometry(rr, rr, 0.08, 6, 1, true), y), t.accent, 2.4);
        this.addPart(merge([seam(h * 0.27, r * 1.09), seam(h * 0.56, r * 1.07), seam(h * 0.71, r * 1.06)]), this.glowMaterial(), false, false);
        break;
      }
      case 'ice': {
        // Faceted ice crystal with a frozen lilac rune inside.
        const side = (a: number, len: number) => {
          const g = merge([
            at(new THREE.CylinderGeometry(r * 0.32, r * 0.36, len, 6), len / 2),
            at(new THREE.ConeGeometry(r * 0.32, len * 0.4, 6), len + len * 0.2),
          ]);
          g.rotateZ(-0.38);
          g.rotateY(a);
          g.translate(Math.cos(a) * r * 0.55, 0, -Math.sin(a) * r * 0.55);
          return g;
        };
        const ice = merge([
          at(new THREE.CylinderGeometry(r * 1.2, r * 1.4, 0.3, 6), 0.15),
          at(new THREE.CylinderGeometry(r * 0.8, r * 0.98, h * 0.78, 6), h * 0.39),
          at(new THREE.ConeGeometry(r * 0.8, h * 0.22, 6), h * 0.78 + h * 0.11),
          side(0.4, 1.5),
          side(2.6, 1.1),
          side(4.4, 1.8),
        ]);
        this.addPart(ice, this.standard({ color: t.color, roughness: 0.42, metalness: 0.05, emissive: 0x0e1a36, flatShading: true }), true);
        const rune = merge([
          tint(at(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 0.06, 6, 1, true), h * 0.48), t.accent, 1.6),
          tint(at(new THREE.CylinderGeometry(r * 0.88, r * 0.88, 0.05, 6, 1, true), h * 0.56), t.accent, 1.2),
        ]);
        this.addPart(rune, this.glowMaterial(), false, false);
        break;
      }
      case 'obelisk': {
        // Square sandstone obelisk with a gold pyramidion and a teal glyph band.
        const top = h - 0.85;
        const body = merge([
          at(new THREE.BoxGeometry(r * 2.3, 0.45, r * 2.3), 0.225),
          at(new THREE.BoxGeometry(r * 1.85, 0.25, r * 1.85), 0.575),
          at(new THREE.CylinderGeometry(r * 0.95, r * 1.25, top - 0.7, 4), 0.7 + (top - 0.7) / 2, 0, 0, Math.PI / 4),
        ]);
        this.addPart(body, this.standard({ roughness: 0.95, color: t.color }, true), true);
        this.addPart(at(new THREE.ConeGeometry(r * 0.95, 0.85, 4), top + 0.425, 0, 0, Math.PI / 4),
          this.standard({ color: t.trim ?? 0xffc860, metalness: 0.85, roughness: 0.3, flatShading: true }), true);
        const bandY = h * 0.55;
        const bandR = r * (1.25 - (0.3 * (bandY - 0.7)) / (top - 0.7)) + 0.03;
        const band = (y: number, w: number) => {
          const g = new THREE.CylinderGeometry(bandR, bandR, w, 4, 1, true);
          return tint(at(g, y, 0, 0, Math.PI / 4), t.accent, 1.5);
        };
        this.addPart(merge([band(bandY, 0.1), band(bandY + 0.22, 0.04), band(bandY - 0.22, 0.04)]), this.glowMaterial(), false, false);
        break;
      }
      case 'monolith': {
        // Obsidian monolith hovering over its plinth, with a floating crystal.
        const stone = merge([
          at(new THREE.CylinderGeometry(r * 1.2, r * 1.35, 0.35, 8), 0.175, 0, 0, Math.PI / 8),
          at(new THREE.CylinderGeometry(r * 0.98, r * 0.8, h * 0.78, 8), 0.62 + h * 0.39, 0, 0, Math.PI / 8),
          at(new THREE.CylinderGeometry(r * 0.55, r * 0.98, 0.3, 8), 0.62 + h * 0.78 + 0.15, 0, 0, Math.PI / 8),
        ]);
        this.addPart(stone, this.standard({ roughness: 0.35, metalness: 0.3, color: t.color, flatShading: true }, true), true);
        const crystal = new THREE.OctahedronGeometry(0.42, 0);
        crystal.scale(1, 1.7, 1);
        const glow = merge([
          tint(at(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.24, 8, 1, true), 0.48, 0, 0, Math.PI / 8), t.accent, 1.6),
          tint(at(new THREE.CylinderGeometry(r * 1.0, r * 1.0, 0.05, 8, 1, true), h * 0.62, 0, 0, Math.PI / 8), t.accent, 1.3),
          tint(at(crystal, h + 0.55), t.trim ?? t.accent, 1.25),
        ]);
        this.addPart(glow, this.glowMaterial(), false, false);
        break;
      }
      case 'freeway': {
        // A Los Angeles freeway column: concrete shaft, flared bent cap, spray-paint colour blocks.
        const shaftH = h - 1.25;
        const shaft = new THREE.CylinderGeometry(r * 0.97, r, shaftH, 16, 8).toNonIndexed();
        shaft.translate(0, 0.3 + shaftH / 2, 0);
        // Whole faces painted, bucketed by angle and height, so the blocks have crisp edges.
        const pos = shaft.attributes.position;
        const col = new Float32Array(pos.count * 3);
        const paint = [0xff4aa8, 0x2ee6d6, 0xffd23a, 0xa65aff, 0xff7a30].map((c) => new THREE.Color(c));
        for (let i = 0; i < pos.count; i += 3) {
          const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
          const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
          const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
          const sector = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 8);
          const band = Math.floor((y - 0.3) / 0.75);
          const k = hash3(sector, band, 0, 5) * 0.5 + 0.5;
          const c = y < 3.3 && k < 0.32 ? paint[Math.floor(k * 1000) % paint.length] : null;
          for (let v = 0; v < 3; v++) col.set(c ? [c.r, c.g, c.b] : [1, 1, 1], (i + v) * 3);
        }
        shaft.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const concrete = merge([
          tint(at(new THREE.CylinderGeometry(r * 1.18, r * 1.26, 0.3, 16), 0.15), 0xffffff, 1),
          shaft,
          tint(at(new THREE.CylinderGeometry(r * 1.32, r * 0.97, 0.35, 16), h - 0.95 + 0.175), 0xffffff, 1),
          tint(at(new THREE.BoxGeometry(2.7, 0.62, 1.5), h - 0.31), 0xffffff, 1),
        ]);
        this.addPart(concrete, this.standard({ roughness: 0.92, color: t.color, vertexColors: true }, true), true);
        break;
      }
    }
  }

  private buildStumps(): void {
    const t = this.theme.pillar;
    const r = P.radius;
    const seg = { column: 10, grove: 12, basalt: 6, ice: 6, obelisk: 4, monolith: 8, freeway: 16, cubicle: 10 }[t.style];
    const flat = t.style !== 'column' && t.style !== 'grove' && t.style !== 'freeway' && t.style !== 'cubicle';
    const material = t.style === 'ice'
      ? new THREE.MeshStandardMaterial({ color: t.stump, roughness: 0.15, metalness: 0.08, emissive: 0x16254a, flatShading: true })
      : this.standard({ roughness: 0.95, color: t.stump, flatShading: flat }, true);
    // Freeway stumps bristle with rusty rebar.
    const rebarMat = t.style === 'freeway' ? new THREE.MeshStandardMaterial({ color: 0x6a3a22, roughness: 0.7, metalness: 0.4 }) : null;
    for (let v = 0; v < 3; v++) {
      const geo = jag(new THREE.CylinderGeometry(r * 0.95, r * 1.3, 0.9, seg, 1), 0.3, 0.35, v * 17.3 + 1);
      geo.translate(0, 0.45, 0);
      if (seg === 4) geo.rotateY(Math.PI / 4);
      const parts: Part[] = [{ geometry: geo, material, perPillar: false, shadow: true }];
      if (rebarMat) {
        const bars: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2 + v;
          const len = 0.5 + ((k * 7 + v * 3) % 5) * 0.12;
          const bar = new THREE.CylinderGeometry(0.025, 0.025, len, 4);
          bar.translate(0, len / 2, 0);
          bar.rotateZ(((k % 3) - 1) * 0.35);
          bar.rotateY(a);
          bar.translate(Math.cos(a) * r * 0.7, 0.75, Math.sin(a) * r * 0.7);
          bars.push(bar);
        }
        parts.push({ geometry: merge(bars), material: rebarMat, perPillar: false, shadow: true });
      }
      this.addStump('pillar', parts);
    }
  }

  // ------------------------------------------------------------------ office cover

  /** Vertex-coloured standard material (office furniture). */
  private furniture(roughness = 0.82): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0.05 });
  }

  /**
   * The office layout's cover: cubicles (grey fabric partitions with aluminium trim, an L desk, a
   * beige CRT with a glowing screen, a chair), banks of filing cabinets, copiers and water coolers.
   * Each kind is one merged, vertex-coloured mesh (tinted per piece for damage) plus at most one
   * glow mesh; stumps are one merged mesh.
   */
  private buildOfficeCover(): void {
    const t = this.theme.pillar;
    const fabric = t.color;
    const trim = t.trim ?? 0xb8bcc2;
    const accent = t.accent;
    const dark = 0x3a3d42;
    const laminate = 0xa89c86;
    const beige = 0xc8c0a8;
    const chairCol = 0x24272c;
    const stumpMat = this.furniture(0.9);
    const glow = this.glowMaterial();

    // ---- cubicle (local: desk along -z, chair facing it)
    {
      const S = C.size / 2, H = C.height, w = 0.06, wallH = H - 0.1;
      const sides = [[0, S - w / 2, 0], [0, -S + w / 2, 0], [S - w / 2, 0, Math.PI / 2], [-S + w / 2, 0, Math.PI / 2]] as const;
      const deskY = 0.74;
      const crtZ = -S + w + 0.3;
      const desk = () => [
        box(2 * S - 2 * w - 0.02, 0.04, 0.66, 0, deskY, -S + w + 0.33, laminate),
        box(0.62, 0.04, 1.1, -S + w + 0.31, deskY, -S + w + 0.66 + 0.55, laminate),
        box(0.42, 0.68, 0.56, S - w - 0.25, 0.36, -S + w + 0.3, 0x6a6e74),
        box(0.04, 0.7, 0.6, -S + w + 0.6, 0.37, 0.17, 0x6a6e74),
      ];
      const g: THREE.BufferGeometry[] = [];
      for (const [x, z, rot] of sides) {
        g.push(box(2 * S - 0.1, wallH, w, x, 0.06 + wallH / 2, z, fabric, 1, rot));
        g.push(box(2 * S, 0.08, w + 0.012, x, 0.04, z, dark, 1, rot));
        g.push(box(2 * S, 0.04, w + 0.03, x, H - 0.02, z, trim, 1, rot));
        g.push(box(0.05, wallH, w + 0.016, x, 0.06 + wallH / 2, z, trim, 1, rot));
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(box(0.08, H, 0.08, sx * (S - 0.04), H / 2, sz * (S - 0.04), trim));
      g.push(...desk());
      g.push(box(0.44, 0.36, 0.4, -0.25, deskY + 0.24, crtZ, beige)); // CRT
      g.push(box(0.3, 0.04, 0.28, -0.25, deskY + 0.04, crtZ, 0xb8b09a));
      g.push(box(0.44, 0.025, 0.15, -0.25, deskY + 0.035, crtZ + 0.4, 0x2e3034)); // keyboard
      g.push(box(0.3, 0.05, 0.22, 0.42, deskY + 0.045, crtZ + 0.02, 0xf0f0ea)); // in-tray
      g.push(box(0.26, 0.02, 0.2, -S + w + 0.3, deskY + 0.03, 0.15, 0xe8e4d8, 1, 0.3)); // memo
      g.push(cyl(0.045, 0.04, 0.1, 8, 0.15, deskY + 0.07, crtZ + 0.26, 0xb83434)); // mug
      const cz = crtZ + 0.85;
      g.push(box(0.48, 0.08, 0.46, -0.2, 0.48, cz, chairCol));
      g.push(box(0.44, 0.5, 0.06, -0.2, 0.8, cz + 0.24, chairCol));
      g.push(cyl(0.03, 0.03, 0.4, 6, -0.2, 0.26, cz, 0x55585c));
      g.push(cyl(0.28, 0.3, 0.05, 10, -0.2, 0.05, cz, chairCol));
      this.beginWhole('cubicle');
      this.addPart(merge(g), this.furniture(), true);
      this.addPart(box(0.34, 0.26, 0.012, -0.25, deskY + 0.25, crtZ + 0.205, accent, 1.3), glow, false, false);

      for (let v = 0; v < 3; v++) {
        const s: THREE.BufferGeometry[] = [];
        sides.forEach(([x, z, rot], k) => {
          s.push(brokenBox(2 * S - 0.1, 0.38 + ((k + v) % 3) * 0.05, w, x, 0.02, z, fabric, v * 13 + k * 3.1, rot, 0.26));
        });
        s.push(...desk());
        const crt = tint(new THREE.BoxGeometry(0.44, 0.36, 0.4), beige, 0.8);
        crt.rotateX(1.3);
        crt.rotateY(v * 1.7);
        s.push(at(crt, 0.2, 0.35, 0.35 - v * 0.2));
        const seat = tint(new THREE.BoxGeometry(0.48, 0.5, 0.08), chairCol, 1);
        seat.rotateX(-1.4);
        s.push(at(seat, 0.08, -0.3, 0.45));
        for (let k = 0; k < 4; k++) s.push(box(0.22, 0.01, 0.3, -0.6 + k * 0.35, 0.01, 0.6 - (k % 2) * 0.5, 0xf2f0e8, 1, k));
        this.addStump('cubicle', [{ geometry: merge(s), material: stumpMat, perPillar: false, shadow: true }]);
      }
    }

    // ---- filing cabinet bank: three lateral cabinets, drawers on both faces
    {
      const d = C.cabinet;
      const hx = d.halfX, hz = d.halfZ, H = d.height;
      const body = this.theme.props.color;
      const g: THREE.BufferGeometry[] = [
        box(2 * hx, H - 0.08, 2 * hz - 0.02, 0, 0.06 + (H - 0.08) / 2, 0, body),
        box(2 * hx - 0.04, 0.06, 2 * hz - 0.06, 0, 0.03, 0, dark),
        box(2 * hx + 0.02, 0.03, 2 * hz + 0.02, 0, H - 0.015, 0, 0x7a786c),
      ];
      const cw = (2 * hx) / 3, dh = (H - 0.14) / 4;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
          for (const s of [-1, 1]) {
            const x = -hx + cw * (i + 0.5), y = 0.08 + dh * (j + 0.5);
            g.push(box(cw - 0.05, dh - 0.03, 0.02, x, y, s * (hz - 0.005), 0x9c9a8c));
            g.push(box(0.2, 0.025, 0.03, x, y + dh * 0.25, s * (hz + 0.01), 0xcfcfcf));
          }
        }
      }
      this.beginWhole('cabinet');
      this.addPart(merge(g), this.furniture(0.6), true);
      for (let v = 0; v < 3; v++) {
        const s = [
          brokenBox(2 * hx, 0.32, 2 * hz - 0.02, 0, 0.02, 0, body, v * 7 + 2, 0, 0.2),
          box(cw - 0.05, dh - 0.03, 0.5, -0.4 + v * 0.3, 0.12, 0.05, 0x9c9a8c, 1, 0.4 * v),
        ];
        this.addStump('cabinet', [{ geometry: merge(s), material: stumpMat, perPillar: false, shadow: true }]);
      }
    }

    // ---- copier
    {
      const g = [
        box(1.04, 0.04, 0.74, 0, 0.02, 0, dark),
        box(1.06, 0.5, 0.78, 0, 0.29, 0, 0xc4c4c0),
        box(1.0, 0.012, 0.02, 0, 0.2, 0.395, 0x6a6c70),
        box(1.0, 0.012, 0.02, 0, 0.37, 0.395, 0x6a6c70),
        box(1.06, 0.36, 0.78, 0, 0.72, 0, 0xdcdcd8),
        box(1.02, 0.1, 0.74, 0, 0.95, 0, 0x7a7c80),
        box(0.34, 0.07, 0.2, 0.26, 1.035, 0.24, 0x4a4e52),
        box(0.4, 0.025, 0.3, -0.25, 1.012, -0.05, 0xf4f4f0),
      ];
      this.beginWhole('copier');
      this.addPart(merge(g), this.furniture(0.5), true);
      this.addPart(merge([
        box(0.14, 0.012, 0.09, 0.22, 1.074, 0.24, accent, 1.4),
        box(0.03, 0.012, 0.03, 0.36, 1.074, 0.29, 0x30ff60, 2),
      ]), glow, false, false);
      for (let v = 0; v < 3; v++) {
        const lid = tint(new THREE.BoxGeometry(1.02, 0.1, 0.74), 0x7a7c80, 1);
        lid.rotateZ(0.5 + v * 0.2);
        this.addStump('copier', [{
          geometry: merge([brokenBox(1.06, 0.42, 0.78, 0, 0.02, 0, 0xc4c4c0, v * 5 + 1, 0, 0.16), at(lid, 0.45, 0.1, 0)]),
          material: stumpMat, perPillar: false, shadow: true,
        }]);
      }
    }

    // ---- water cooler
    {
      const bottle = 0x86c4ec;
      const g = [
        box(0.38, 0.9, 0.38, 0, 0.45, 0, 0xe2e2de),
        box(0.2, 0.03, 0.1, 0, 0.62, 0.2, 0x55585c),
        box(0.04, 0.05, 0.05, -0.06, 0.78, 0.2, 0x3a7ae0),
        box(0.04, 0.05, 0.05, 0.06, 0.78, 0.2, 0xe03a3a),
        cyl(0.06, 0.16, 0.08, 14, 0, 0.94, 0, bottle),
        cyl(0.16, 0.16, 0.34, 14, 0, 1.15, 0, bottle),
        cyl(0.13, 0.16, 0.04, 14, 0, 1.34, 0, bottle),
      ];
      this.beginWhole('cooler');
      this.addPart(merge(g), this.furniture(0.35), true);
      for (let v = 0; v < 3; v++) {
        const b = tint(new THREE.CylinderGeometry(0.16, 0.16, 0.4, 12), bottle, 1);
        b.rotateZ(Math.PI / 2);
        b.rotateY(v * 2.1);
        this.addStump('cooler', [{
          geometry: merge([brokenBox(0.38, 0.32, 0.38, 0, 0.02, 0, 0xe2e2de, v * 3 + 9, 0, 0.14), at(b, 0.16, Math.cos(v * 2.1) * 0.45, -Math.sin(v * 2.1) * 0.45)]),
          material: stumpMat, perPillar: false, shadow: true,
        }]);
      }
    }
  }

  // ------------------------------------------------------------------ props

  private instancedMesh(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, target: THREE.Group, shadow = true): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    this.geometries.push(geo);
    this.instanced.push(m);
    target.add(m);
    return m;
  }

  private buildProps(): void {
    const t = this.theme;
    const W = A.wallRadius;
    const d = new THREE.Object3D();
    const set = (m: THREE.InstancedMesh, i: number) => {
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
    };
    const r = rng(101);
    const ring = (min: number, max: number) => {
      const a = r() * Math.PI * 2;
      const rr = W + min + r() * (max - min);
      return [Math.sin(a) * rr, Math.cos(a) * rr, a] as const;
    };
    const color = new THREE.Color();

    switch (t.props.style) {
      case 'stones': {
        // The original standing stones, spaced for the bigger wall.
        const count = 38;
        const stones = this.instancedMesh(new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 1, flatShading: true }), count, this.props);
        stones.receiveShadow = false;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + (i % 3) * 0.05;
          const rr = W + 5 + (i % 4) * 1.6;
          const h = 3 + ((i * 37) % 7);
          d.position.set(Math.sin(a) * rr, h / 2 - 0.3, Math.cos(a) * rr);
          d.rotation.set(((i * 13) % 5) * 0.03, -a, ((i * 7) % 5) * 0.04);
          d.scale.set(1.6, h, 1.1);
          set(stones, i);
        }
        break;
      }
      case 'forest': {
        const trees = 36;
        const trunkGeo = new THREE.CylinderGeometry(0.22, 0.4, 1, 7);
        trunkGeo.translate(0, 0.5, 0);
        const trunks = this.instancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 1, flatShading: true }), trees, this.props);
        const crowns = this.instancedMesh(new THREE.IcosahedronGeometry(1, 0),
          new THREE.MeshStandardMaterial({ color: t.pillar.trim ?? 0x26491f, roughness: 0.9, flatShading: true }), trees * 2, this.props);
        for (let i = 0; i < trees; i++) {
          const a = (i / trees) * Math.PI * 2 + (r() - 0.5) * 0.12;
          const rr = W + 4 + (i % 3) * 4 + r() * 2.5;
          const th = 5 + r() * 4.5;
          const s = 1 + r() * 0.7;
          d.position.set(Math.sin(a) * rr, -0.2, Math.cos(a) * rr);
          d.rotation.set((r() - 0.5) * 0.1, r() * 6, (r() - 0.5) * 0.1);
          d.scale.set(s, th, s);
          set(trunks, i);
          const cs = 2.4 + r() * 1.4;
          d.position.y = th - 0.4;
          d.rotation.set(r(), r() * 6, r());
          d.scale.set(cs, cs * 1.15, cs);
          set(crowns, i * 2);
          d.position.y = th + cs * 0.75;
          d.position.x += (r() - 0.5) * 1.2;
          d.scale.multiplyScalar(0.7);
          set(crowns, i * 2 + 1);
        }
        const shroomGeo = new THREE.SphereGeometry(0.5, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
        const shrooms = this.instancedMesh(shroomGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), 34, this.props, false);
        for (let i = 0; i < 34; i++) {
          const [x, z] = ring(1.3, 5);
          const s = 0.35 + r() * 0.7;
          d.position.set(x, 0, z);
          d.rotation.set(0, r() * 6, 0);
          d.scale.set(s, s * 0.7, s);
          set(shrooms, i);
          shrooms.setColorAt(i, color.setHex(i % 3 ? t.props.accent : 0x70ffd8).multiplyScalar(1.4));
        }
        break;
      }
      case 'spires': {
        const spireGeo = new THREE.ConeGeometry(1, 1, 6, 1);
        spireGeo.translate(0, 0.5, 0);
        const spires = this.instancedMesh(spireGeo, new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 0.9, flatShading: true }), 36, this.props);
        for (let i = 0; i < 36; i++) {
          const [x, z] = ring(4, 22);
          const s = 1.2 + r() * 1.6;
          d.position.set(x, -0.3, z);
          d.rotation.set((r() - 0.5) * 0.15, r() * 6, (r() - 0.5) * 0.15);
          d.scale.set(s, 4 + r() * 10, s);
          set(spires, i);
        }
        const rocks = this.instancedMesh(new THREE.DodecahedronGeometry(1, 0),
          new THREE.MeshStandardMaterial({ color: 0x1a1010, emissive: t.props.accent, emissiveIntensity: 1.4, roughness: 0.8, flatShading: true }),
          22, this.props, false);
        for (let i = 0; i < 22; i++) {
          const [x, z] = ring(2, 14);
          const s = 0.5 + r() * 1.2;
          d.position.set(x, -0.25 * s, z);
          d.rotation.set(r() * 6, r() * 6, r() * 6);
          d.scale.set(s * 1.3, s * 0.7, s);
          set(rocks, i);
        }
        break;
      }
      case 'shards': {
        const shards = this.instancedMesh(new THREE.OctahedronGeometry(1, 0),
          new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 0.15, metalness: 0.1, emissive: 0x10203a, flatShading: true }), 40, this.props);
        for (let i = 0; i < 40; i++) {
          const [x, z] = ring(3, 18);
          const sy = 2.5 + r() * 6;
          d.position.set(x, sy * 0.55, z);
          d.rotation.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5);
          d.scale.set(0.7 + r() * 0.8, sy, 0.7 + r() * 0.8);
          set(shards, i);
        }
        const mounds = this.instancedMesh(new THREE.SphereGeometry(1, 12, 6),
          new THREE.MeshStandardMaterial({ color: t.props.accent, roughness: 1 }), 22, this.props, false);
        mounds.receiveShadow = true;
        for (let i = 0; i < 22; i++) {
          const [x, z] = ring(2, 16);
          d.position.set(x, 0, z);
          d.rotation.set(0, r() * 6, 0);
          d.scale.set(3 + r() * 3.5, 0.7 + r(), 3 + r() * 3);
          set(mounds, i);
        }
        break;
      }
      case 'ruins': {
        const sandstone = this.standard({ color: t.props.color, roughness: 0.95 }, true);
        const colGeo = new THREE.CylinderGeometry(0.7, 0.78, 1, 10);
        colGeo.translate(0, 0.5, 0);
        const cols = this.instancedMesh(colGeo, sandstone, 28, this.props);
        // Four broken colonnades, each an arc of seven columns.
        for (let i = 0; i < 28; i++) {
          const group = Math.floor(i / 7);
          const a = (group / 4) * Math.PI * 2 + 0.5 + (i % 7) * 0.075;
          const rr = W + 6 + (group % 2) * 3;
          d.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr);
          d.rotation.set(0, r() * 6, 0);
          d.scale.set(1, (i % 7) === 3 ? 7 : 1.4 + r() * 5, 1);
          set(cols, i);
        }
        const blocks = this.instancedMesh(new THREE.BoxGeometry(1, 1, 1), sandstone, 20, this.props);
        for (let i = 0; i < 20; i++) {
          const [x, z, a] = ring(4, 13);
          d.position.set(x, 0.3, z);
          d.rotation.set((r() - 0.5) * 0.4, -a + (r() - 0.5), (r() - 0.5) * 0.3);
          d.scale.set(1.6 + r() * 1.8, 0.7 + r() * 0.6, 0.9 + r() * 0.6);
          set(blocks, i);
        }
        const dunes = this.instancedMesh(new THREE.SphereGeometry(1, 16, 8),
          new THREE.MeshStandardMaterial({ color: t.props.accent, roughness: 1 }), 16, this.terrain, false);
        dunes.receiveShadow = true;
        for (let i = 0; i < 16; i++) {
          const [x, z, a] = ring(12, 40);
          const sy = 1.6 + r() * 2.4;
          d.position.set(x, -sy * 0.45, z);
          d.rotation.set(0, -a + (r() - 0.5), 0);
          d.scale.set(12 + r() * 10, sy, 6 + r() * 5);
          set(dunes, i);
        }
        break;
      }
      case 'asteroids': {
        const rocks = this.instancedMesh(new THREE.DodecahedronGeometry(1, 0),
          new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 0.85, flatShading: true }), 44, this.props);
        rocks.receiveShadow = false;
        for (let i = 0; i < 44; i++) {
          const [x, z] = ring(4, 40);
          const s = 0.6 + r() * 2.8;
          d.position.set(x, -10 + r() * 26, z);
          d.rotation.set(r() * 6, r() * 6, r() * 6);
          d.scale.set(s * (0.8 + r() * 0.5), s * (0.6 + r() * 0.4), s);
          set(rocks, i);
        }
        const crystalGeo = new THREE.OctahedronGeometry(1, 0);
        const crystals = this.instancedMesh(crystalGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), 30, this.props, false);
        for (let i = 0; i < 30; i++) {
          // Some hang under the island, the rest drift among the rocks.
          const under = i < 10;
          const [x, z] = under ? [(r() - 0.5) * W * 1.2, (r() - 0.5) * W * 1.2] : ring(2, 28);
          const s = 0.25 + r() * 0.4;
          d.position.set(x, under ? -4 - r() * 9 : -3 + r() * 14, z);
          d.rotation.set((r() - 0.5) * 0.6, r() * 6, (r() - 0.5) * 0.6);
          d.scale.set(s, s * (2.5 + r() * 2), s);
          set(crystals, i);
          crystals.setColorAt(i, color.setHex(i % 2 ? t.pillar.accent : (t.pillar.trim ?? t.pillar.accent)).multiplyScalar(1.8));
        }
        // Rocky underside of the floating arena.
        const island = new THREE.ConeGeometry(W + 0.8, 18, 48, 6, true);
        island.rotateX(Math.PI);
        island.translate(0, -9, 0);
        const pos = island.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (y > -0.5) continue;
          const k = 1 + hash3(x, y, z, 3) * 0.12;
          pos.setXYZ(i, x * k, y + hash3(z, x, y, 7) * 0.8, z * k);
        }
        island.computeVertexNormals();
        this.geometries.push(island);
        const rock = new THREE.Mesh(island, new THREE.MeshStandardMaterial({ color: t.props.color, roughness: 0.9, flatShading: true }));
        rock.receiveShadow = true;
        this.terrain.add(rock);
        break;
      }
      case 'city':
        this.buildCity(r, d, set);
        break;
      case 'office':
        this.buildOffice(r, d, set);
        break;
    }
    for (const m of this.instanced) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  /** A merged, never-tinted mesh in the props or terrain (one draw call). */
  private addStatic(geo: THREE.BufferGeometry, mat: THREE.Material, target: THREE.Group, shadow = false): THREE.Mesh {
    this.geometries.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    target.add(m);
    return m;
  }

  /**
   * Los Angeles at dusk: two rows of city blocks (one merged mesh with a lit-window facade), neon
   * strips, signs, storefronts and street lights (one glow mesh), all terrain; and palm trees
   * (instanced trunks and crowns), the props a palm GLB replaces.
   */
  private buildCity(r: () => number, d: THREE.Object3D, set: (m: THREE.InstancedMesh, i: number) => void): void {
    const W = A.wallRadius;
    const facade = this.regen(() => drawFacade(), 1, 1);
    const facadeGlow = this.regen(() => drawFacade(true), 1, 1);
    const blocks: THREE.BufferGeometry[] = [];
    const neon: THREE.BufferGeometry[] = [];
    const NEON = [0xff3ca0, 0x30e8d8, 0xa65aff, 0xff8a30, 0xffd23a];
    /** Place a local-space geometry: turned by `a` (local -z faces the arena), pushed out to `rr`. */
    const place = (geo: THREE.BufferGeometry, a: number, rr: number) => {
      geo.rotateY(a);
      geo.translate(Math.sin(a) * rr, 0, Math.cos(a) * rr);
      return geo;
    };
    const rows = [
      // Low strip malls and storefronts, then mid-rise blocks behind.
      { count: 22, rr: 42, depth: 9, h: [3.6, 8], neon: true, off: 0.08 },
      { count: 18, rr: 58, depth: 12, h: [7, 18], neon: false, off: 0.3 },
    ];
    // Keep the sunset side low so the sun and the skyline on the horizon show over the roofs.
    const sky = this.theme.sky.moonDir;
    const sunAngle = Math.atan2(sky[0], sky[2]);
    for (const row of rows) {
      for (let i = 0; i < row.count; i++) {
        const a = (i / row.count) * Math.PI * 2 + row.off + (r() - 0.5) * 0.05;
        const frontage = ((Math.PI * 2 * row.rr) / row.count) * (0.66 + r() * 0.24);
        const da = Math.atan2(Math.sin(a - sunAngle), Math.cos(a - sunAngle));
        const low = 1 - 0.65 * Math.exp(-((da / 0.75) ** 2));
        const h = Math.max(3.6, (row.h[0] + r() * (row.h[1] - row.h[0])) * low);
        const depth = row.depth * (0.8 + r() * 0.4);
        const geo = new THREE.BoxGeometry(frontage, h, depth);
        // UVs in window units (3 m wide, 3.5 m tall), shifted by whole windows so blocks differ.
        const uv = geo.attributes.uv;
        const du = Math.floor(r() * 4) / 4, dv = Math.floor(r() * 4) / 4;
        for (let f = 0; f < 6; f++) {
          const faceW = f < 2 ? depth : frontage;
          for (let k = 0; k < 4; k++) {
            const i4 = f * 4 + k;
            if (f === 2 || f === 3) uv.setXY(i4, 0.02, 0.02); // roofs: plain wall texel
            else uv.setXY(i4, uv.getX(i4) * (faceW / 3) + du, uv.getY(i4) * (h / 3.5) + dv);
          }
        }
        geo.translate(0, h / 2, depth / 2);
        blocks.push(place(geo, a, row.rr));
        if (!row.neon) continue;
        // Street level: lit storefront glass, a neon strip, sometimes a sign or a vertical tube.
        const front: THREE.BufferGeometry[] = [];
        const c1 = NEON[Math.floor(r() * NEON.length)], c2 = NEON[Math.floor(r() * NEON.length)];
        front.push(box(frontage * 0.8, 2.4, 0.06, 0, 1.4, -0.04, 0xffb070, 0.85));
        front.push(box(frontage * 0.86, 0.14, 0.14, 0, 3.3, -0.14, c1, 2.4));
        if (r() < 0.6) front.push(box(2.4 + r() * 1.6, 0.8, 0.18, (r() - 0.5) * frontage * 0.4, 4.4, -0.2, c2, 1.9));
        if (r() < 0.5) front.push(box(0.14, Math.min(h - 1, 6 + r() * 6), 0.14, frontage * 0.43, 1 + Math.min(h - 1, 6 + r() * 6) / 2, -0.14, c2, 2.2));
        for (const g of front) neon.push(place(g, a, row.rr));
      }
    }
    // Street lights just outside the wall: dark poles (merged with the blocks, mapped to plain wall) and sodium lamps.
    for (let i = 0; i < 10; i++) {
      const a = ((i + 0.5) / 10) * Math.PI * 2;
      const pole = flatUV(at(new THREE.BoxGeometry(0.18, 7, 0.18), 3.5), 0.02, 0.02);
      const arm = flatUV(at(new THREE.BoxGeometry(0.12, 0.12, 1.6), 6.9, 0, -0.8), 0.02, 0.02);
      blocks.push(place(pole, a, W + 2.6), place(arm, a, W + 2.6));
      neon.push(place(box(0.28, 0.12, 0.5, 0, 6.8, -1.55, 0xff9a40, 2.6), a, W + 2.6));
    }
    this.addStatic(merge(blocks), new THREE.MeshStandardMaterial({
      map: facade, emissiveMap: facadeGlow, emissive: 0xffffff, emissiveIntensity: 0.8, color: 0x9a8a9a, roughness: 0.9,
    }), this.terrain);
    this.addStatic(merge(neon), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), this.terrain);

    // Palms between the wall and the blocks, a few more behind.
    const palms = 22;
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.24, 1, 7, 6);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = this.instancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a463a, roughness: 1, flatShading: true }), palms, this.props);
    const fronds: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 11; k++) {
      const f = new THREE.PlaneGeometry(2.6, 0.5, 8, 1);
      f.translate(1.3, 0, 0);
      f.rotateX(-Math.PI / 2);
      const pos = f.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        pos.setY(i, 0.35 * x - 0.24 * x * x);
        pos.setZ(i, pos.getZ(i) * (1.1 - x / 2.8));
      }
      f.rotateY((k / 11) * Math.PI * 2 + (k % 2) * 0.2);
      f.computeVertexNormals();
      fronds.push(f);
    }
    const crowns = this.instancedMesh(merge(fronds),
      new THREE.MeshStandardMaterial({ color: 0x2c4426, roughness: 0.9, side: THREE.DoubleSide }), palms, this.props);
    const top = new THREE.Vector3();
    for (let i = 0; i < palms; i++) {
      const behind = i >= 16;
      const a = (i / (behind ? 6 : 16)) * Math.PI * 2 + (behind ? 0.25 : 0) + (r() - 0.5) * 0.1;
      const rr = behind ? 52 + r() * 4 : W + 4 + r() * 4;
      const h = behind ? 13 + r() * 5 : 7 + r() * 5;
      d.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr);
      d.rotation.set((r() - 0.5) * 0.16, r() * 6, (r() - 0.5) * 0.16);
      d.scale.set(1, h, 1);
      set(trunks, i);
      top.set(0, h, 0).applyEuler(d.rotation).add(d.position);
      d.position.copy(top);
      d.rotation.set(0, r() * 6, 0);
      d.scale.setScalar(0.9 + r() * 0.4);
      set(crowns, i);
    }
  }

  /**
   * Indoors: the room (a ceiling with fluorescent panels, beige walls with blind-covered windows,
   * support columns, and a sea of cubicles with glowing screens), all terrain; and filing cabinets,
   * water coolers and potted plants near the wall, the props a prop GLB replaces.
   */
  private buildOffice(r: () => number, d: THREE.Object3D, set: (m: THREE.InstancedMesh, i: number) => void): void {
    const t = this.theme;
    const W = A.wallRadius;
    const H = C.ceilingHeight;
    const R = ROOM_RADIUS;
    // Ceiling: one 8 x 8 tile texture every 7.2 m, the troffers glow through the emissive map.
    const span = (R + 4) * 2;
    const ceilingGeo = new THREE.CircleGeometry(R + 4, 64);
    const ceiling = this.addStatic(ceilingGeo, new THREE.MeshStandardMaterial({
      map: this.regen(() => drawCeiling(), span / 7.2, span / 7.2),
      emissiveMap: this.regen(() => drawCeiling(true), span / 7.2, span / 7.2),
      emissive: 0xeefff2, emissiveIntensity: 1.05, roughness: 0.95,
    }), this.terrain);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = H;
    ceiling.name = 'ceiling';
    // Walls: one window bay every ~6 m, daylight through the blinds.
    const bays = Math.round((Math.PI * 2 * R) / 6);
    const wallGeo = new THREE.CylinderGeometry(R, R, H, 96, 1, true);
    wallGeo.translate(0, H / 2, 0);
    const walls = this.addStatic(wallGeo, new THREE.MeshStandardMaterial({
      map: this.regen(() => drawOfficeWall(), bays, 1),
      emissiveMap: this.regen(() => drawOfficeWall(true), bays, 1),
      emissive: 0xeaf4ff, emissiveIntensity: 0.9, roughness: 0.95, side: THREE.BackSide,
    }), this.terrain);
    this.roomWalls = walls;
    const columns = this.instancedMesh(new THREE.BoxGeometry(1.1, H, 1.1),
      new THREE.MeshStandardMaterial({ color: 0xcabd98, roughness: 0.95 }), 12, this.terrain, false);
    const colSpots: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      colSpots.push([Math.sin(a) * 46, Math.cos(a) * 46]);
      d.position.set(colSpots[i][0], H / 2, colSpots[i][1]);
      d.rotation.set(0, a, 0);
      d.scale.set(1, 1, 1);
      set(columns, i);
    }

    // The cubicle farm beyond the arena: blocks of 3 x 2 back-to-back cubicles with aisles.
    const S = C.size / 2, ph = C.height;
    const shell = merge([
      box(2 * S, ph, 0.06, 0, ph / 2, S - 0.03, t.pillar.color),
      box(2 * S, ph, 0.06, 0, ph / 2, -S + 0.03, t.pillar.color),
      box(0.06, ph, 2 * S, S - 0.03, ph / 2, 0, t.pillar.color),
      box(0.06, ph, 2 * S, -S + 0.03, ph / 2, 0, t.pillar.color),
      box(2 * S - 0.1, 0.04, 0.66, 0, 0.74, -S + 0.39, 0xa89c86),
      box(0.44, 0.36, 0.4, -0.25, 0.98, -S + 0.36, 0xc8c0a8),
      box(0.48, 0.55, 0.46, -0.2, 0.5, 0.15, 0x24272c),
    ]);
    const cells: [number, number, number][] = [];
    for (let bx = -60; bx <= 60; bx += 9.2) {
      for (let bz = -60; bz <= 60; bz += 7.2) {
        for (let i = -1; i <= 1; i++) {
          for (const j of [-0.5, 0.5]) {
            const x = bx + i * 2 * S, z = bz + j * 2 * S;
            const rr = Math.hypot(x, z);
            if (rr < W + 10.5 || rr > R - 5) continue;
            if (colSpots.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 2.2)) continue;
            cells.push([x, z, j < 0 ? Math.PI : 0]);
          }
        }
      }
    }
    const farm = this.instancedMesh(shell, this.furniture(), cells.length, this.terrain, false);
    farm.receiveShadow = true;
    const screens = this.instancedMesh(box(0.34, 0.26, 0.012, -0.25, 0.99, -S + 0.565, t.pillar.accent, 1.2),
      this.glowMaterial(), cells.length, this.terrain, false);
    cells.forEach(([x, z, yaw], i) => {
      d.position.set(x, 0, z);
      d.rotation.set(0, yaw, 0);
      d.scale.set(1, 1, 1);
      set(farm, i);
      set(screens, i);
    });

    // Props near the wall: filing cabinet banks, water coolers, potted plants.
    const cab = C.cabinet;
    const cabinetGeo = merge([
      box(2 * cab.halfX, cab.height, 2 * cab.halfZ, 0, cab.height / 2, 0, t.props.color),
      ...[0, 1, 2, 3].map((j) => box(2 * cab.halfX - 0.06, 0.012, 0.02, 0, 0.08 + ((cab.height - 0.14) / 4) * (j + 1), cab.halfZ + 0.01, 0x5a5850)),
    ]);
    const cabinets = this.instancedMesh(cabinetGeo, this.furniture(0.6), 14, this.props);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.11;
      const rr = W + 3.2 + (i % 2) * 2.5;
      d.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr);
      d.rotation.set(0, a + Math.PI, 0);
      d.scale.set(1, 1, 1);
      set(cabinets, i);
    }
    const coolerGeo = merge([
      box(0.38, 0.9, 0.38, 0, 0.45, 0, 0xe2e2de),
      cyl(0.16, 0.16, 0.42, 12, 0, 1.12, 0, 0x86c4ec),
    ]);
    const coolers = this.instancedMesh(coolerGeo, this.furniture(0.35), 8, this.props);
    const plantGeo = merge([
      cyl(0.24, 0.18, 0.42, 10, 0, 0.21, 0, 0x8a7a68),
      at(tint(new THREE.IcosahedronGeometry(0.55, 0).scale(1, 1.3, 1), 0x3c6a34, 1), 0.95),
      at(tint(new THREE.IcosahedronGeometry(0.4, 0), 0x4c7c3c, 1), 1.45, 0.12, 0.08),
    ]);
    const plants = this.instancedMesh(plantGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), 12, this.props);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.5;
      d.position.set(Math.sin(a) * (W + 2.4), 0, Math.cos(a) * (W + 2.4));
      d.rotation.set(0, a + Math.PI, 0);
      set(coolers, i);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3;
      const rr = W + 2.2 + r() * 5;
      d.position.set(Math.sin(a) * rr, 0, Math.cos(a) * rr);
      d.rotation.set(0, r() * 6, 0);
      d.scale.setScalar(0.85 + r() * 0.4);
      set(plants, i);
    }
  }
}

/**
 * Per-axis scale that fits a box-shaped cover model (a cubicle) to its box collider: footprint
 * `2 * halfX` by `2 * halfZ` and height `height`, from its bounding box in its own space.
 */
export function boxFitScale(root: THREE.Object3D, halfX: number, halfZ: number, height: number): [number, number, number] {
  root.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(root);
  const s = box3.getSize(new THREE.Vector3());
  const k = (want: number, have: number) => (have > 1e-3 ? THREE.MathUtils.clamp(want / have, 0.05, 20) : 1);
  return [k(2 * halfX, s.x), k(height, s.y), k(2 * halfZ, s.z)];
}

/**
 * XZ scale that fits a pillar model's shaft to the cylinder collider: measures the median radius of
 * the vertices in the middle third of its height (the shaft, ignoring a wide base or capital).
 */
export function pillarFitScale(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const y0 = box.min.y + (box.max.y - box.min.y) * 0.33;
  const y1 = box.min.y + (box.max.y - box.min.y) * 0.67;
  const radii: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.y >= y0 && v.y <= y1) radii.push(Math.hypot(v.x - cx, v.z - cz));
    }
  });
  if (radii.length < 3) return 1;
  radii.sort((a, b) => a - b);
  // The outer surface: a high percentile, so interior vertices don't shrink the estimate.
  const shaft = radii[Math.floor(radii.length * 0.85)];
  return shaft > 1e-3 ? THREE.MathUtils.clamp(P.radius / shaft, 0.25, 4) : 1;
}
