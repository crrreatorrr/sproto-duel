import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Physics } from '../physics/Physics';
import type { Debris } from './Debris';

const P = CONFIG.arena.pillars;

/** What a piece of cover is (picks its look and debris). Types live in CONFIG.arena.obstacles. */
export type ObstacleKind =
  | 'pillar'
  | 'cubicle' | 'cabinet' | 'copier' | 'cooler' | 'glass'
  | 'stall' | 'rugs' | 'cart' | 'pots'
  | 'candle' | 'block'
  | 'car' | 'truck' | 'dumpster' | 'shelter' | 'planter'
  | 'rockA' | 'rockB' | 'ruin';

/** One solid piece of an obstacle's collider, in the obstacle's own (unturned) frame. */
export interface ColliderPart {
  shape: 'box' | 'cylinder';
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  radius: number;
  /** Extra yaw of a box part. */
  yaw: number;
  /** Bottom and top (m); y0 > 0 is a roof you can walk under. */
  y0: number;
  height: number;
}

/** Collider, toughness and behaviour of one piece of cover. */
export interface ObstacleShape {
  kind: ObstacleKind;
  /** One cylinder, one box, or several parts. */
  collider: 'cylinder' | 'box' | 'compound';
  parts: ColliderPart[];
  /** Cylinder radius (single cylinder), else the smaller half extent. */
  radius: number;
  /** Bounds of all parts in the obstacle's own frame: half extents and centre. */
  halfX: number;
  halfZ: number;
  cx: number;
  cz: number;
  /** Yaw (radians) of the collider and the visual. Plain cylinders get a random visual yaw instead. */
  yaw: number;
  /** Highest top of any part. */
  height: number;
  /** Collider left after a crumble (0 = none): blocks walking, chest-height spells fly over it. */
  stumpHeight: number;
  /** Stump footprint relative to the standing one. */
  stumpScale: number;
  /** Health (unused when not destructible). */
  hp: number;
  /** Tall and wide enough to hide behind (AI cover). */
  cover: boolean;
  /** Breaks when its health runs out; otherwise spells only chip it. */
  destructible: boolean;
  /** Transparent (glass): stops spells, not sight. */
  seeThrough: boolean;
  /** Casts shadows. */
  shadow: boolean;
  /** Placement index within its layout (picks colours and models). */
  variant: number;
}

/** The classic column: CONFIG.arena.pillars. */
export const PILLAR_SHAPE: ObstacleShape = {
  kind: 'pillar', collider: 'cylinder',
  parts: [{ shape: 'cylinder', x: 0, z: 0, halfX: P.radius, halfZ: P.radius, radius: P.radius, yaw: 0, y0: 0, height: P.height }],
  radius: P.radius, halfX: P.radius, halfZ: P.radius, cx: 0, cz: 0, yaw: 0,
  height: P.height, stumpHeight: 0.9, stumpScale: 1.15, hp: P.hp, cover: true,
  destructible: true, seeThrough: false, shadow: true, variant: 0,
};

/** One look for a pillar (per theme): the standing column and the stump it leaves behind. */
interface PillarVisual {
  whole: THREE.Object3D;
  stump: THREE.Object3D;
  /** Tintable materials (own copies, so damage shows per pillar). */
  materials: THREE.MeshStandardMaterial[];
  baseColors: THREE.Color[];
  baseEmissive: THREE.Color[];
}

/**
 * A piece of cover: a pillar, or any obstacle of a boss arena (cubicles, stalls, cars, rocks...).
 * Blocks movement and spells (and sight, unless see-through); destructible ones crumble to a low
 * stump (or shatter, for glass) and reset each round. Moving ones slide on a rail (Arena drives them).
 */
export class Pillar {
  hp: number;
  alive = true;
  /** Part of the arena's current layout (inactive ones are hidden and have no collision). */
  active = true;
  readonly position: THREE.Vector3;
  private readonly root = new THREE.Group();
  private readonly whole = new THREE.Group();
  private readonly visuals = new Map<string, PillarVisual>();
  private visual: PillarVisual | null = null;
  private readonly colliders: RAPIER.Collider[];
  private readonly stumpColliders: RAPIER.Collider[];
  private readonly body: RAPIER.RigidBody;
  private readonly cosYaw: number;
  private readonly sinYaw: number;
  /** Visual key last shown per theme (a theme's placeholder is dropped once its model arrives). */
  private readonly themeKeys = new Map<string, string>();
  private wobble = 0;
  private hitGlow = 0;

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    x: number,
    z: number,
    private readonly debris: Debris,
    readonly shape: ObstacleShape = PILLAR_SHAPE,
    /** Slides on a rail (kinematic body, moved with `moveTo`). */
    readonly moving = false,
  ) {
    this.hp = shape.hp;
    this.position = new THREE.Vector3(x, 0, z);
    this.root.position.copy(this.position);
    this.root.rotation.y = shape.collider === 'cylinder' ? Math.random() * Math.PI * 2 : shape.yaw;
    this.cosYaw = Math.cos(shape.yaw);
    this.sinYaw = Math.sin(shape.yaw);
    scene.add(this.root);
    this.root.add(this.whole);

    const colliders = physics.addPillar(x, z, shape, this, moving);
    this.body = colliders.body;
    this.colliders = colliders.full;
    this.stumpColliders = colliders.stump;
  }

  /** Move a sliding obstacle: the collider follows on the next physics step (`snap`: at once). */
  moveTo(x: number, z: number, snap = false): void {
    this.position.set(x, 0, z);
    this.root.position.copy(this.position);
    if (snap) this.body.setTranslation({ x, y: 0, z }, true);
    else this.body.setNextKinematicTranslation({ x, y: 0, z });
  }

  // ------------------------------------------------------------------ geometry (AI, spells, QA)

  /** Is this cover box-shaped or compound (anything but one plain cylinder)? */
  get isBox(): boolean {
    return this.shape.collider !== 'cylinder';
  }

  /** Is this tall and wide enough to hide behind? */
  get cover(): boolean {
    return this.shape.cover;
  }

  /** Top of whatever collider is live: the standing piece or its stump (0 if nothing is left). */
  get top(): number {
    return this.alive ? this.shape.height : this.shape.stumpHeight;
  }

  /** Radius of the circle around the centre that contains the whole standing footprint. */
  get boundingRadius(): number {
    let r = 0;
    for (const p of this.shape.parts) {
      const ext = p.shape === 'box' ? Math.hypot(p.halfX, p.halfZ) : p.radius;
      r = Math.max(r, Math.hypot(p.x, p.z) + ext);
    }
    return r;
  }

  /** Parts of whatever collider is live (a stump keeps only the parts standing on the floor). */
  private liveParts(): ColliderPart[] {
    if (this.alive) return this.shape.parts;
    return this.shape.stumpHeight > 0 ? this.shape.parts.filter((p) => p.y0 === 0) : [];
  }

  /** (x, z) relative to the centre, in the obstacle's own axes. */
  private local(x: number, z: number): [number, number] {
    const dx = x - this.position.x, dz = z - this.position.z;
    // Inverse of the yaw (three.js and Rapier both turn +x toward -z for a positive yaw).
    return [dx * this.cosYaw - dz * this.sinYaw, dx * this.sinYaw + dz * this.cosYaw];
  }

  /** A point in the obstacle's frame, in a part's own axes. */
  private static inPart(p: ColliderPart, lx: number, lz: number): [number, number] {
    const dx = lx - p.x, dz = lz - p.z;
    if (!p.yaw) return [dx, dz];
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  /** Horizontal distance from (x, z) to the live footprint's edge (0 inside it; Infinity if nothing is left). */
  surfaceDistance(x: number, z: number): number {
    const k = this.alive ? 1 : this.shape.stumpScale;
    const [lx, lz] = this.local(x, z);
    let best = Infinity;
    for (const p of this.liveParts()) {
      const [px, pz] = Pillar.inPart(p, lx, lz);
      const d = p.shape === 'box'
        ? Math.hypot(Math.max(0, Math.abs(px) - p.halfX * k), Math.max(0, Math.abs(pz) - p.halfZ * k))
        : Math.max(0, Math.hypot(px, pz) - p.radius * k);
      best = Math.min(best, d);
    }
    return best;
  }

  /** Closest point on the live footprint to (x, z), written into out.x/out.z (out.y untouched). */
  closestPoint(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const k = this.alive ? 1 : this.shape.stumpScale;
    const [lx, lz] = this.local(x, z);
    let best = Infinity, bx = 0, bz = 0;
    for (const p of this.liveParts()) {
      const [px, pz] = Pillar.inPart(p, lx, lz);
      let qx: number, qz: number;
      if (p.shape === 'box') {
        qx = THREE.MathUtils.clamp(px, -p.halfX * k, p.halfX * k);
        qz = THREE.MathUtils.clamp(pz, -p.halfZ * k, p.halfZ * k);
      } else {
        const d = Math.hypot(px, pz), r = p.radius * k;
        const f = d > r ? r / d : 1;
        qx = px * f;
        qz = pz * f;
      }
      const d = Math.hypot(px - qx, pz - qz);
      if (d < best) {
        best = d;
        // Back into the obstacle frame.
        const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        bx = p.x + qx * c + qz * s;
        bz = p.z - qx * s + qz * c;
      }
    }
    if (best === Infinity) {
      out.x = this.position.x;
      out.z = this.position.z;
      return out;
    }
    out.x = this.position.x + bx * this.cosYaw + bz * this.sinYaw;
    out.z = this.position.z - bx * this.sinYaw + bz * this.cosYaw;
    return out;
  }

  /** How far the standing footprint (floor parts) reaches from the centre along the unit direction (dx, dz). */
  extentToward(dx: number, dz: number): number {
    const lx = dx * this.cosYaw - dz * this.sinYaw;
    const lz = dx * this.sinYaw + dz * this.cosYaw;
    let best = 0;
    for (const p of this.shape.parts) {
      if (p.y0 > 0) continue;
      let e: number;
      if (p.shape === 'box') {
        const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        e = Math.abs(lx * c - lz * s) * p.halfX + Math.abs(lx * s + lz * c) * p.halfZ;
      } else {
        e = p.radius;
      }
      best = Math.max(best, p.x * lx + p.z * lz + e);
    }
    return best;
  }

  // ------------------------------------------------------------------ visuals

  /**
   * Show the visual cached under `key`, building it on first use. Switching is just a re-parent:
   * meshes and materials are kept for the next time the theme comes back.
   */
  setVisual(key: string, build: () => { whole: THREE.Object3D; stump: THREE.Object3D }): void {
    let v = this.visuals.get(key);
    if (!v) {
      const parts = build();
      v = { whole: parts.whole, stump: parts.stump, materials: [], baseColors: [], baseEmissive: [] };
      const list = v;
      parts.whole.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'emissive' in m && !m.transparent && !list.materials.includes(m)) {
          list.materials.push(m);
          list.baseColors.push(m.color.clone());
          list.baseEmissive.push(m.emissive.clone());
        }
      });
      this.visuals.set(key, v);
    }
    if (v === this.visual) return;
    if (this.visual) {
      this.whole.remove(this.visual.whole);
      this.root.remove(this.visual.stump);
    }
    this.visual = v;
    this.whole.add(v.whole);
    this.root.add(v.stump);
    v.stump.visible = !this.alive;
    this.applyTint();
    this.applyGlow();
  }

  /**
   * Show a theme's visual under `key`; if the theme last showed another key (its placeholder before
   * a model arrived), that visual is freed.
   */
  setThemeVisual(themeId: string, key: string, build: () => { whole: THREE.Object3D; stump: THREE.Object3D }): void {
    this.setVisual(key, build);
    const prev = this.themeKeys.get(themeId);
    this.themeKeys.set(themeId, key);
    if (prev && prev !== key) this.dropVisual(prev);
  }

  hasVisual(key: string): boolean {
    return this.visuals.has(key);
  }

  /** The standing column's visual root (QA and tools). */
  get column(): THREE.Object3D | null {
    return this.visual?.whole ?? null;
  }

  /** Which visual is shown and which part of it is visible (QA and tools). */
  describe(): { key: string | null; wholeVisible: boolean; stumpVisible: boolean } {
    let key: string | null = null;
    for (const [k, v] of this.visuals) if (v === this.visual) key = k;
    return { key, wholeVisible: this.root.visible && this.whole.visible && !!this.visual, stumpVisible: this.root.visible && !!this.visual?.stump.visible };
  }

  /** Forget a cached visual (e.g. a theme's placeholder once its GLB arrived). Frees its own materials. */
  dropVisual(key: string): void {
    const v = this.visuals.get(key);
    if (!v || v === this.visual) return;
    for (const m of v.materials) m.dispose();
    this.visuals.delete(key);
  }

  /** Join or leave the arena's current layout: visibility and collision follow. */
  setActive(on: boolean): void {
    this.active = on;
    this.root.visible = on;
    for (const c of this.colliders) c.setEnabled(on && this.alive);
    for (const c of this.stumpColliders) c.setEnabled(on && !this.alive);
  }

  // ------------------------------------------------------------------ damage

  /** Returns true if this hit destroyed the pillar. */
  damage(amount: number, point: THREE.Vector3): boolean {
    if (!this.active) return false;
    if (!this.alive) {
      this.debris.spawn(point, 1, 0.5); // chips off the stump
      return false;
    }
    if (!this.shape.destructible) {
      // Permanent cover: it shudders and chips, it never breaks.
      this.wobble = Math.min(0.5, this.wobble + 0.15);
      this.hitGlow = 0.6;
      events.emit('pillarHit', { pos: point });
      this.debris.spawn(point, 1 + Math.round(amount / 12), 0.45);
      return false;
    }
    this.hp -= amount * P.spellDamageMultiplier;
    this.wobble = Math.min(1, this.wobble + 0.35 + amount / 40);
    this.hitGlow = 1;
    events.emit('pillarHit', { pos: point });
    if (this.hp <= 0) {
      this.crumble();
      return true;
    }
    this.debris.spawn(point, 2 + Math.round(amount / 8), 0.6);
    this.applyTint();
    return false;
  }

  private applyTint(): void {
    const v = this.visual;
    if (!v) return;
    const frac = this.shape.destructible ? Math.max(0, this.hp) / this.shape.hp : 1;
    for (let i = 0; i < v.materials.length; i++) {
      v.materials[i].color.copy(v.baseColors[i]).multiplyScalar(0.55 + 0.45 * frac);
    }
  }

  private applyGlow(): void {
    const v = this.visual;
    if (!v) return;
    const g = this.hitGlow;
    for (let i = 0; i < v.materials.length; i++) {
      const b = v.baseEmissive[i];
      v.materials[i].emissive.setRGB(b.r + g * 0.5, b.g + g * 0.35, b.b + g * 0.25);
    }
  }

  private crumble(): void {
    const s = this.shape;
    this.alive = false;
    this.hp = 0;
    this.whole.visible = false;
    if (this.visual) this.visual.stump.visible = true;
    for (const c of this.colliders) c.setEnabled(false);
    for (const c of this.stumpColliders) c.setEnabled(true);
    const center = this.position.clone();
    center.y = s.height * 0.5;
    if (s.kind === 'pillar') {
      this.debris.spawnColumn(this.position, s.height, s.radius, 26);
    } else {
      // Panels, planks and shards topple outward from above the stump.
      const n = Math.round(8 + this.boundingRadius * 7);
      this.debris.spawnColumn(this.position, Math.max(0.4, s.height - s.stumpHeight), this.boundingRadius * 0.7, n, Math.max(0.3, s.stumpHeight));
    }
    events.emit('pillarBreak', { pos: center, glass: s.seeThrough });
  }

  reset(): void {
    this.hp = this.shape.hp;
    this.alive = true;
    this.whole.visible = true;
    if (this.visual) this.visual.stump.visible = false;
    for (const c of this.colliders) c.setEnabled(this.active);
    for (const c of this.stumpColliders) c.setEnabled(false);
    this.wobble = 0;
    this.hitGlow = 0;
    this.applyTint();
    this.applyGlow();
    this.whole.rotation.set(0, 0, 0);
  }

  update(dt: number, time: number): void {
    if (!this.alive || !this.active) return;
    if (this.wobble > 0) {
      this.wobble = Math.max(0, this.wobble - dt * 3);
      // Short, squat cover shakes harder than a tall column.
      const w = this.wobble * this.wobble * (this.shape.height > 3 ? 0.03 : 0.06);
      this.whole.rotation.x = Math.sin(time * 45) * w;
      this.whole.rotation.z = Math.cos(time * 39) * w;
    }
    if (this.hitGlow > 0) {
      this.hitGlow = Math.max(0, this.hitGlow - dt * 6);
      this.applyGlow();
    }
  }
}
