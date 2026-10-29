import * as THREE from 'three';
import type { Effects } from '../fx/Effects';
import type { Wizard } from '../wizard/Wizard';

/**
 * Momentum Staff: the damaging ribbon a Blink Dash leaves behind.
 * Damage is `trailDps` over `life` seconds, dealt in 1 HP chunks so the popup doesn't fire every tick.
 * `'trail'` is not a spell, so `spellDamageScale` does not apply (see SpellSystem).
 */
export interface BlinkSpawn {
  wizard: Wizard;
  color: number;
  width: number;
  dps: number;
  life: number;
}

type Deal = (target: Wizard, source: Wizard, amount: number, point: THREE.Vector3) => void;

interface Trail {
  wizard: Wizard;
  from: THREE.Vector3;
  to: THREE.Vector3;
  width: number;
  dps: number;
  life: number;
  age: number;
  color: number;
  frozen: boolean;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Damage not yet applied, per target. */
  bank: Map<Wizard, number>;
}

const UP = new THREE.Vector3(0, 1, 0);

function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / ab2));
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.hypot(dx, dz);
}

export class BlinkTrails {
  private readonly trails: Trail[] = [];
  private readonly geo = new THREE.BoxGeometry(1, 1, 1);
  private readonly point = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly wizards: readonly Wizard[],
    private readonly deal: Deal,
    private readonly fx: Effects,
  ) {}

  spawn(s: BlinkSpawn): void {
    const mat = new THREE.MeshBasicMaterial({
      color: s.color,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.trails.push({
      wizard: s.wizard,
      from: s.wizard.blinkFrom.clone(),
      to: s.wizard.pos.clone(),
      width: s.width,
      dps: s.dps,
      life: s.life,
      age: 0,
      color: s.color,
      frozen: false,
      mesh,
      mat,
      bank: new Map(),
    });
  }

  update(dt: number): void {
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      if (t.wizard.blinking) t.to.copy(t.wizard.pos);
      else if (!t.frozen) {
        t.to.copy(t.wizard.pos);
        t.frozen = true;
      }
      t.age += dt;
      this.pose(t);
      this.hurt(t, dt);
      if (t.age >= t.life) this.remove(i);
    }
  }

  clear(): void {
    while (this.trails.length) this.remove(this.trails.length - 1);
  }

  releaseOwned(w: Wizard): void {
    for (let i = this.trails.length - 1; i >= 0; i--) if (this.trails[i].wizard === w) this.remove(i);
  }

  private pose(t: Trail): void {
    const len = Math.max(0.05, Math.hypot(t.to.x - t.from.x, t.to.z - t.from.z));
    t.mesh.scale.set(t.width, 0.22, len);
    t.mesh.position.set((t.from.x + t.to.x) / 2, 0.4, (t.from.z + t.to.z) / 2);
    t.mesh.up.copy(UP);
    t.mesh.lookAt(t.to.x, 0.4, t.to.z);
    const fade = 1 - t.age / t.life;
    t.mat.opacity = Math.max(0, fade) * 0.55;
    if (t.age < 0.2) this.fx.trail(t.to, t.color, 0.35, 2);
  }

  private hurt(t: Trail, dt: number): void {
    const reach = t.width * 0.5;
    for (const target of this.wizards) {
      if (target === t.wizard || !target.alive || target.invulnerable) continue;
      if (distPointSeg(target.pos.x, target.pos.z, t.from.x, t.from.z, t.to.x, t.to.z) > reach) continue;
      const bank = (t.bank.get(target) ?? 0) + t.dps * dt;
      if (bank < 1) {
        t.bank.set(target, bank);
        continue;
      }
      t.bank.set(target, bank - Math.floor(bank));
      this.point.set((t.from.x + t.to.x) / 2, target.pos.y + 0.8, (t.from.z + t.to.z) / 2);
      this.deal(target, t.wizard, Math.floor(bank), this.point);
    }
  }

  private remove(i: number): void {
    const t = this.trails[i];
    this.scene.remove(t.mesh);
    t.mat.dispose();
    this.trails[i] = this.trails[this.trails.length - 1];
    this.trails.pop();
  }
}
