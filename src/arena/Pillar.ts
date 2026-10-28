import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Physics } from '../physics/Physics';
import type { Debris } from './Debris';

const P = CONFIG.arena.pillars;
/** Stump collider: blocks walking, but chest-height spells fly over it. */
const STUMP_HEIGHT = 0.9;

/** One look for a pillar (per theme): the standing column and the stump it leaves behind. */
interface PillarVisual {
  whole: THREE.Object3D;
  stump: THREE.Object3D;
  /** Tintable materials (own copies, so damage shows per pillar). */
  materials: THREE.MeshStandardMaterial[];
  baseColors: THREE.Color[];
  baseEmissive: THREE.Color[];
}

export class Pillar {
  hp: number = P.hp;
  alive = true;
  readonly position: THREE.Vector3;
  private readonly root = new THREE.Group();
  private readonly whole = new THREE.Group();
  private readonly visuals = new Map<string, PillarVisual>();
  private visual: PillarVisual | null = null;
  private readonly collider: RAPIER.Collider;
  private readonly stumpCollider: RAPIER.Collider;
  private wobble = 0;
  private hitGlow = 0;

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    x: number,
    z: number,
    private readonly debris: Debris,
  ) {
    this.position = new THREE.Vector3(x, 0, z);
    this.root.position.copy(this.position);
    this.root.rotation.y = Math.random() * Math.PI * 2;
    scene.add(this.root);
    this.root.add(this.whole);

    const colliders = physics.addPillar(x, z, P.radius, P.height, STUMP_HEIGHT, this);
    this.collider = colliders.full;
    this.stumpCollider = colliders.stump;
  }

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
    return { key, wholeVisible: this.whole.visible && !!this.visual, stumpVisible: !!this.visual?.stump.visible };
  }

  /** Forget a cached visual (e.g. a theme's placeholder once its GLB arrived). Frees its own materials. */
  dropVisual(key: string): void {
    const v = this.visuals.get(key);
    if (!v || v === this.visual) return;
    for (const m of v.materials) m.dispose();
    this.visuals.delete(key);
  }

  /** Returns true if this hit destroyed the pillar. */
  damage(amount: number, point: THREE.Vector3): boolean {
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
    const frac = Math.max(0, this.hp) / P.hp;
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
    this.alive = false;
    this.hp = 0;
    this.whole.visible = false;
    if (this.visual) this.visual.stump.visible = true;
    this.collider.setEnabled(false);
    this.stumpCollider.setEnabled(true);
    const center = this.position.clone();
    center.y = P.height * 0.5;
    this.debris.spawnColumn(this.position, P.height, P.radius, 26);
    events.emit('pillarBreak', { pos: center });
  }

  reset(): void {
    this.hp = P.hp;
    this.alive = true;
    this.whole.visible = true;
    if (this.visual) this.visual.stump.visible = false;
    this.collider.setEnabled(true);
    this.stumpCollider.setEnabled(false);
    this.wobble = 0;
    this.hitGlow = 0;
    this.applyTint();
    this.applyGlow();
    this.whole.rotation.set(0, 0, 0);
  }

  update(dt: number, time: number): void {
    if (!this.alive) return;
    if (this.wobble > 0) {
      this.wobble = Math.max(0, this.wobble - dt * 3);
      const w = this.wobble * this.wobble * 0.03;
      this.whole.rotation.x = Math.sin(time * 45) * w;
      this.whole.rotation.z = Math.cos(time * 39) * w;
    }
    if (this.hitGlow > 0) {
      this.hitGlow = Math.max(0, this.hitGlow - dt * 6);
      this.applyGlow();
    }
  }
}
