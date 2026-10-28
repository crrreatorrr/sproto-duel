import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Physics } from '../physics/Physics';
import type { Debris } from './Debris';

const P = CONFIG.arena.pillars;

/** What a piece of destructible cover is (picks its look and debris). */
export type ObstacleKind = 'pillar' | 'cubicle' | 'cabinet' | 'copier' | 'cooler';

/** Collider and toughness of one piece of destructible cover. */
export interface ObstacleShape {
  kind: ObstacleKind;
  /** 'cylinder' uses `radius`; 'box' uses `halfX` / `halfZ`, turned by `yaw`. */
  collider: 'cylinder' | 'box';
  radius: number;
  halfX: number;
  halfZ: number;
  /** Yaw (radians) of the collider and the visual. Cylinders get a random visual yaw instead. */
  yaw: number;
  height: number;
  /** Collider left after a crumble: blocks walking, chest-height spells fly over it. */
  stumpHeight: number;
  /** Stump footprint relative to the standing one. */
  stumpScale: number;
  hp: number;
  /** Tall and wide enough to hide behind (AI cover). */
  cover: boolean;
}

/** The classic column: CONFIG.arena.pillars. */
export const PILLAR_SHAPE: ObstacleShape = {
  kind: 'pillar', collider: 'cylinder', radius: P.radius, halfX: P.radius, halfZ: P.radius, yaw: 0,
  height: P.height, stumpHeight: 0.9, stumpScale: 1.15, hp: P.hp, cover: true,
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
 * Destructible cover: a pillar, or (office layout) a cubicle, filing cabinets, a copier or a water
 * cooler. Blocks movement, spells and line of sight; crumbles to a low stump; resets each round.
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
  private readonly collider: RAPIER.Collider;
  private readonly stumpCollider: RAPIER.Collider;
  private readonly cosYaw: number;
  private readonly sinYaw: number;
  private wobble = 0;
  private hitGlow = 0;

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    x: number,
    z: number,
    private readonly debris: Debris,
    readonly shape: ObstacleShape = PILLAR_SHAPE,
  ) {
    this.hp = shape.hp;
    this.position = new THREE.Vector3(x, 0, z);
    this.root.position.copy(this.position);
    this.root.rotation.y = shape.collider === 'box' ? shape.yaw : Math.random() * Math.PI * 2;
    this.cosYaw = Math.cos(shape.yaw);
    this.sinYaw = Math.sin(shape.yaw);
    scene.add(this.root);
    this.root.add(this.whole);

    const colliders = physics.addPillar(x, z, shape, this);
    this.collider = colliders.full;
    this.stumpCollider = colliders.stump;
  }

  // ------------------------------------------------------------------ geometry (AI, spells, QA)

  /** Is this cover a box (cubicle, cabinets, copier)? */
  get isBox(): boolean {
    return this.shape.collider === 'box';
  }

  /** Is this tall and wide enough to hide behind? */
  get cover(): boolean {
    return this.shape.cover;
  }

  /** Top of whatever collider is live: the standing piece or its stump. */
  get top(): number {
    return this.alive ? this.shape.height : this.shape.stumpHeight;
  }

  /** Radius of the circle around the centre that contains the whole standing footprint. */
  get boundingRadius(): number {
    const s = this.shape;
    return s.collider === 'box' ? Math.hypot(s.halfX, s.halfZ) : s.radius;
  }

  /** Footprint of whatever collider is live (the stump may be wider). */
  private extents(): [number, number, number] {
    const s = this.shape;
    const k = this.alive ? 1 : s.stumpScale;
    return [s.halfX * k, s.halfZ * k, s.radius * k];
  }

  /** (x, z) relative to the centre, in the box's own axes. */
  private local(x: number, z: number): [number, number] {
    const dx = x - this.position.x, dz = z - this.position.z;
    // Inverse of the yaw (three.js and Rapier both turn +x toward -z for a positive yaw).
    return [dx * this.cosYaw - dz * this.sinYaw, dx * this.sinYaw + dz * this.cosYaw];
  }

  /** Horizontal distance from (x, z) to the live footprint's edge (0 inside it). */
  surfaceDistance(x: number, z: number): number {
    const [hx, hz, r] = this.extents();
    if (!this.isBox) return Math.max(0, Math.hypot(x - this.position.x, z - this.position.z) - r);
    const [lx, lz] = this.local(x, z);
    return Math.hypot(Math.max(0, Math.abs(lx) - hx), Math.max(0, Math.abs(lz) - hz));
  }

  /** Closest point on the live footprint to (x, z), written into out.x/out.z (out.y untouched). */
  closestPoint(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const [hx, hz, r] = this.extents();
    if (!this.isBox) {
      const dx = x - this.position.x, dz = z - this.position.z;
      const d = Math.hypot(dx, dz);
      const k = d > r ? r / d : 1;
      out.x = this.position.x + dx * k;
      out.z = this.position.z + dz * k;
      return out;
    }
    let [lx, lz] = this.local(x, z);
    lx = THREE.MathUtils.clamp(lx, -hx, hx);
    lz = THREE.MathUtils.clamp(lz, -hz, hz);
    out.x = this.position.x + lx * this.cosYaw + lz * this.sinYaw;
    out.z = this.position.z - lx * this.sinYaw + lz * this.cosYaw;
    return out;
  }

  /** How far the standing footprint reaches from the centre along the unit direction (dx, dz). */
  extentToward(dx: number, dz: number): number {
    const s = this.shape;
    if (!this.isBox) return s.radius;
    const lx = dx * this.cosYaw - dz * this.sinYaw;
    const lz = dx * this.sinYaw + dz * this.cosYaw;
    return Math.abs(lx) * s.halfX + Math.abs(lz) * s.halfZ;
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
        if (m && 'emissive' in m && !list.materials.includes(m)) {
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
    this.collider.setEnabled(on && this.alive);
    this.stumpCollider.setEnabled(on && !this.alive);
  }

  // ------------------------------------------------------------------ damage

  /** Returns true if this hit destroyed the pillar. */
  damage(amount: number, point: THREE.Vector3): boolean {
    if (!this.active) return false;
    if (!this.alive) {
      this.debris.spawn(point, 1, 0.5); // chips off the stump
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
    const frac = Math.max(0, this.hp) / this.shape.hp;
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
    this.collider.setEnabled(false);
    this.stumpCollider.setEnabled(true);
    const center = this.position.clone();
    center.y = s.height * 0.5;
    if (s.kind === 'pillar') {
      this.debris.spawnColumn(this.position, s.height, s.radius, 26);
    } else {
      // Partitions and panels topple outward from chest height.
      const n = Math.round(8 + this.boundingRadius * 7);
      this.debris.spawnColumn(this.position, s.height - s.stumpHeight, this.boundingRadius * 0.7, n, s.stumpHeight);
    }
    events.emit('pillarBreak', { pos: center });
  }

  reset(): void {
    this.hp = this.shape.hp;
    this.alive = true;
    this.whole.visible = true;
    if (this.visual) this.visual.stump.visible = false;
    this.collider.setEnabled(this.active);
    this.stumpCollider.setEnabled(false);
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
      const w = this.wobble * this.wobble * (this.shape.kind === 'pillar' ? 0.03 : 0.06);
      this.whole.rotation.x = Math.sin(time * 45) * w;
      this.whole.rotation.z = Math.cos(time * 39) * w;
    }
    if (this.hitGlow > 0) {
      this.hitGlow = Math.max(0, this.hitGlow - dt * 6);
      this.applyGlow();
    }
  }
}
