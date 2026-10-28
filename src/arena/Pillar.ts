import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Physics } from '../physics/Physics';
import type { AssetLoader } from '../assets/AssetLoader';
import type { Debris } from './Debris';

const P = CONFIG.arena.pillars;
/** Stump collider: blocks walking, but chest-height spells fly over it. */
const STUMP_HEIGHT = 0.9;

export class Pillar {
  hp: number = P.hp;
  alive = true;
  readonly position: THREE.Vector3;
  private readonly whole = new THREE.Group();
  private readonly stump: THREE.Object3D;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly collider: RAPIER.Collider;
  private readonly stumpCollider: RAPIER.Collider;
  private wobble = 0;
  private hitGlow = 0;
  private readonly baseColors: THREE.Color[] = [];

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    x: number,
    z: number,
    stone: THREE.Texture,
    assets: AssetLoader,
    private readonly debris: Debris,
  ) {
    this.position = new THREE.Vector3(x, 0, z);
    const root = new THREE.Group();
    root.position.copy(this.position);
    root.rotation.y = Math.random() * Math.PI * 2;
    scene.add(root);
    root.add(this.whole);

    const model = assets.instantiate('pillar');
    if (model) {
      // Clones share materials; give each pillar its own so damage tint stays per pillar.
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
      });
      this.whole.add(model.root);
    } else {
      const mat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.9, color: 0xb9b2c4 });
      const r = P.radius;
      const h = P.height;
      const part = (geo: THREE.BufferGeometry, y: number) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.y = y;
        m.castShadow = m.receiveShadow = true;
        this.whole.add(m);
      };
      part(new THREE.CylinderGeometry(r * 1.3, r * 1.4, 0.45, 14), 0.225);
      part(new THREE.CylinderGeometry(r * 0.92, r, h - 0.9, 14, 4), h / 2);
      part(new THREE.CylinderGeometry(r * 1.3, r * 1.05, 0.45, 14), h - 0.225);
      // Floating rune band for a bit of magic.
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(r * 1.05, 0.03, 6, 32),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7fb2ff).multiplyScalar(2), toneMapped: false }),
      );
      band.rotation.x = Math.PI / 2;
      band.position.y = h * 0.62;
      this.whole.add(band);
    }
    this.whole.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && 'emissive' in m && !this.materials.includes(m)) {
        this.materials.push(m);
        this.baseColors.push(m.color.clone());
      }
    });

    const stumpModel = assets.instantiate('pillarBroken');
    if (stumpModel) {
      this.stump = stumpModel.root;
    } else {
      const geo = new THREE.CylinderGeometry(P.radius * 0.95, P.radius * 1.3, 0.9, 10, 1);
      // Jagged top.
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.3) pos.setY(i, pos.getY(i) + (Math.random() - 0.3) * 0.35);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95, color: 0x8f889a }));
      m.position.y = 0.45;
      m.castShadow = m.receiveShadow = true;
      this.stump = m;
    }
    this.stump.visible = false;
    root.add(this.stump);

    const colliders = physics.addPillar(x, z, P.radius, P.height, STUMP_HEIGHT, this);
    this.collider = colliders.full;
    this.stumpCollider = colliders.stump;
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
    const frac = this.hp / P.hp;
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].color.copy(this.baseColors[i]).multiplyScalar(0.55 + 0.45 * frac);
    }
    return false;
  }

  private crumble(): void {
    this.alive = false;
    this.hp = 0;
    this.whole.visible = false;
    this.stump.visible = true;
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
    this.stump.visible = false;
    this.collider.setEnabled(true);
    this.stumpCollider.setEnabled(false);
    this.wobble = 0;
    this.hitGlow = 0;
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].color.copy(this.baseColors[i]);
      this.materials[i].emissive.setRGB(0, 0, 0);
    }
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
      for (const m of this.materials) m.emissive.setRGB(this.hitGlow * 0.5, this.hitGlow * 0.35, this.hitGlow * 0.25);
    }
  }
}
