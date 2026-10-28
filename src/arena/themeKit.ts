import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import type { ArenaTheme } from './themes';

const A = CONFIG.arena;
const P = A.pillars;

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
  const out = mergeGeometries(list, false)!;
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
  /** Terrain that stays even with a prop GLB (dunes, the floating island's underside). */
  readonly terrain = new THREE.Group();
  private readonly pillarParts: Part[] = [];
  private readonly stumpParts: Part[][] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  /** Every material that samples the theme stone texture (templates and per-pillar clones). */
  private readonly stoneUsers: THREE.MeshStandardMaterial[] = [];
  private readonly spin: number;

  constructor(readonly theme: ArenaTheme, private stone: THREE.Texture) {
    this.buildPillar();
    this.buildStumps();
    this.buildProps();
    this.spin = theme.props.style === 'asteroids' ? 0.012 : 0;
    this.props.name = `props:${theme.id}`;
    this.terrain.name = `terrain:${theme.id}`;
  }

  /** One placeholder pillar: shared geometry, its own copies of tintable materials. */
  makePillar(): THREE.Object3D {
    const g = new THREE.Group();
    for (const p of this.pillarParts) {
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

  makeStump(index: number): THREE.Object3D {
    const parts = this.stumpParts[index % this.stumpParts.length];
    const g = new THREE.Group();
    for (const p of parts) {
      const m = new THREE.Mesh(p.geometry, p.material);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    return g;
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
    this.pillarParts.push({ geometry, material, perPillar, shadow });
  }

  private buildPillar(): void {
    const t = this.theme.pillar;
    const r = P.radius;
    const h = P.height;
    switch (t.style) {
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
    }
  }

  private buildStumps(): void {
    const t = this.theme.pillar;
    const r = P.radius;
    const seg = { column: 10, grove: 12, basalt: 6, ice: 6, obelisk: 4, monolith: 8 }[t.style];
    const flat = t.style !== 'column' && t.style !== 'grove';
    const material = t.style === 'ice'
      ? new THREE.MeshStandardMaterial({ color: t.stump, roughness: 0.15, metalness: 0.08, emissive: 0x16254a, flatShading: true })
      : this.standard({ roughness: 0.95, color: t.stump, flatShading: flat }, true);
    for (let v = 0; v < 3; v++) {
      const geo = jag(new THREE.CylinderGeometry(r * 0.95, r * 1.3, 0.9, seg, 1), 0.3, 0.35, v * 17.3 + 1);
      geo.translate(0, 0.45, 0);
      if (seg === 4) geo.rotateY(Math.PI / 4);
      this.geometries.push(geo);
      this.stumpParts.push([{ geometry: geo, material, perPillar: false, shadow: true }]);
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
    }
    for (const m of this.instanced) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }
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
