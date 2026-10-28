import * as THREE from 'three';
import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Effects } from './Effects';
import { glowTexture } from './textures';
import type { Projectile } from '../spells/Projectile';
import type { Wizard } from '../wizard/Wizard';
import { WizardVisual } from '../wizard/WizardVisual';

const RS = CONFIG.rewardSpells;
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpColor = new THREE.Color();
const GOLD = new THREE.Color(1, 0.78, 0.35);
const GREEN = new THREE.Color(0.35, 1, 0.5);
const FLAME_A = new THREE.Color(1, 0.62, 0.18);
const FLAME_B = new THREE.Color(1, 0.3, 0.06);
const FLAME_HOT = new THREE.Color(1, 0.92, 0.6);
const SMOKE = new THREE.Color(0.32, 0.3, 0.3);
const VAPOR = new THREE.Color(0.86, 0.84, 0.97);

/** The rug's face: deep red field, gold border and medallion, cream fringe (canvas-drawn once). */
function carpetTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f0e0b8';
  g.fillRect(0, 0, 256, 160);
  // Fringe at the short ends.
  g.strokeStyle = '#e8d3a0';
  g.lineWidth = 2;
  for (let x = 2; x < 256; x += 5) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 10);
    g.moveTo(x, 150);
    g.lineTo(x, 160);
    g.stroke();
  }
  g.fillStyle = '#7a1424';
  g.fillRect(4, 10, 248, 140);
  g.strokeStyle = '#e8b04a';
  g.lineWidth = 6;
  g.strokeRect(12, 18, 232, 124);
  g.lineWidth = 2;
  g.strokeStyle = '#2a3f8a';
  g.strokeRect(22, 28, 212, 104);
  // Medallion and corner diamonds.
  const diamond = (x: number, y: number, rx: number, ry: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(x, y - ry);
    g.lineTo(x + rx, y);
    g.lineTo(x, y + ry);
    g.lineTo(x - rx, y);
    g.closePath();
    g.fill();
  };
  diamond(128, 80, 58, 40, '#e8b04a');
  diamond(128, 80, 44, 30, '#2a3f8a');
  diamond(128, 80, 26, 18, '#c83a2a');
  diamond(128, 80, 9, 6, '#f6e2a8');
  for (const [x, y] of [[40, 44], [216, 44], [40, 116], [216, 116]]) diamond(x, y, 12, 9, '#e8b04a');
  // Woven speckle.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    g.fillRect(4 + Math.random() * 248, 10 + Math.random() * 140, 2, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A flying carpet under one rider: rippling cloth that scales in on summon and out on landing. */
class CarpetLook {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly base: Float32Array;
  /** 0 hidden .. 1 full size. */
  show = 0;
  constructor(scene: THREE.Scene, material: THREE.MeshStandardMaterial) {
    const geo = new THREE.PlaneGeometry(1.0, 1.6, 6, 14);
    geo.rotateX(-Math.PI / 2); // flat, long axis along z (the rider's forward)
    this.base = Float32Array.from(geo.attributes.position.array as Float32Array);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(w: Wizard, dt: number, time: number): void {
    const target = w.riding ? 1 : 0;
    this.show = THREE.MathUtils.damp(this.show, target, target ? 14 : 9, dt);
    const m = this.mesh;
    m.visible = this.show > 0.02 && w.active;
    if (!m.visible) return;
    const root = w.visual.root;
    const k = w.sizeScale;
    m.position.set(root.position.x, root.position.y - 0.04, root.position.z);
    m.rotation.set(0, root.rotation.y, 0);
    // Bank into turns and pitch with speed.
    const speed = Math.hypot(w.vel.x, w.vel.z);
    m.rotateX(-Math.min(0.14, speed * 0.008));
    m.scale.set(k * (0.4 + 0.6 * this.show), 1, k * this.show);
    // Ripple travelling back along the rug, stronger at the trailing edge, edges curling up.
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      const x = this.base[i], z = this.base[i + 2];
      const back = THREE.MathUtils.clamp((0.8 - z) / 1.6, 0, 1);
      a[i + 1] = Math.sin(z * 5.5 + time * 13) * 0.05 * (0.3 + back) + x * x * 0.12;
    }
    pos.needsUpdate = true;
    m.geometry.computeVertexNormals();
  }
}

/** Pump It: three phones orbiting the wizard and a green chart arrow climbing over its head. */
class PumpLook {
  readonly group = new THREE.Group();
  private readonly phones: THREE.Group[] = [];
  private readonly chart = new THREE.Group();
  private readonly glow: THREE.Sprite;
  private readonly chartMat: THREE.MeshBasicMaterial;
  show = 0;
  constructor(scene: THREE.Scene) {
    const body = new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.35, metalness: 0.6 });
    const screen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1, 0.45).multiplyScalar(1.6), toneMapped: false });
    for (let i = 0; i < 3; i++) {
      const ph = new THREE.Group();
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.2, 0.014), body);
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.095, 0.17), screen);
      s.position.z = 0.008;
      const s2 = s.clone();
      s2.position.z = -0.008;
      s2.rotation.y = Math.PI;
      ph.add(b, s, s2);
      this.phones.push(ph);
      this.group.add(ph);
    }
    // A rising candlestick line: four zig-zag segments and an arrowhead.
    this.chartMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1, 0.45).multiplyScalar(2), toneMapped: false, transparent: true, depthWrite: false });
    const pts: [number, number][] = [[-0.36, -0.22], [-0.16, -0.02], [-0.02, -0.12], [0.16, 0.12], [0.3, 0.26]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len + 0.03, 0.045, 0.02), this.chartMat);
      seg.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
      seg.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      this.chart.add(seg);
    }
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.16, 3), this.chartMat);
    head.position.set(0.33, 0.29, 0);
    head.rotation.z = -Math.PI / 4;
    this.chart.add(head);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: new THREE.Color(0.3, 1, 0.45).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    }));
    this.glow.scale.setScalar(1.1);
    this.chart.add(this.glow);
    this.group.add(this.chart);
    this.group.visible = false;
    scene.add(this.group);
  }

  update(w: Wizard, dt: number, time: number): void {
    const target = w.pumped ? 1 : 0;
    this.show = THREE.MathUtils.damp(this.show, target, 10, dt);
    this.group.visible = this.show > 0.02 && w.active && w.alive;
    if (!this.group.visible) return;
    const root = w.visual.root;
    const k = w.sizeScale * root.scale.x;
    this.group.position.copy(root.position);
    const r = 0.8 * k * this.show;
    this.phones.forEach((ph, i) => {
      const a = time * 3.2 + (i / 3) * Math.PI * 2;
      ph.position.set(Math.sin(a) * r, (1.15 + Math.sin(time * 4 + i * 2) * 0.12) * k, Math.cos(a) * r);
      ph.rotation.set(0.3 * Math.sin(time * 5 + i), a + Math.PI / 2, 0.25);
      ph.scale.setScalar(this.show);
    });
    // The chart climbs, resets, climbs again; it always faces the camera.
    const u = (time * 0.9) % 1;
    this.chart.position.set(0, (2.25 + u * 0.35) * k, 0);
    this.chart.scale.setScalar(k * this.show * (0.9 + 0.2 * Math.sin(time * 6)));
    this.chartMat.opacity = Math.min(1, (1 - u) * 3) * this.show;
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.6 * this.show;
    tmp.copy(WizardVisual.viewer).sub(this.group.position);
    this.chart.rotation.set(0, Math.atan2(tmp.x, tmp.z), 0);
  }
}

/**
 * Visuals for the boss reward spells (src/spells/RewardSpells.ts): the flying carpet, Pump It's
 * phones and chart, Hellfire Breath's flames, the burning debuff, Lock-On's green bolt trails and
 * every cast's burst. The vape cloud's puffs are drawn by the Arena with its other clouds. Purely
 * visual: synced every rendered frame after the wizards' visuals.
 */
export class RewardFx {
  private readonly carpets = new Map<Wizard, CarpetLook>();
  private readonly pumps = new Map<Wizard, PumpLook>();
  private carpetMat: THREE.MeshStandardMaterial | null = null;
  private time = 0;
  private flameAcc = 0;
  private readonly breathLight = new THREE.PointLight(0xff7a2a, 0, 9, 2);

  constructor(private readonly scene: THREE.Scene, private readonly fx: Effects, private readonly wizards: Wizard[]) {
    scene.add(this.breathLight);
    events.on('rewardCast', (e) => this.castBurst(e.wizard, e.spell, e.pos));
    events.on('rewardEnd', (e) => {
      if (e.spell === 'carpet' && e.wizard.active) this.fx.dust(tmp.set(e.wizard.pos.x, e.wizard.pos.y + 0.1, e.wizard.pos.z), 5, 0.9);
    });
  }

  private carpetFor(w: Wizard): CarpetLook {
    let c = this.carpets.get(w);
    if (!c) {
      this.carpetMat ??= new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.85, side: THREE.DoubleSide });
      this.carpets.set(w, (c = new CarpetLook(this.scene, this.carpetMat)));
    }
    return c;
  }

  private pumpFor(w: Wizard): PumpLook {
    let p = this.pumps.get(w);
    if (!p) this.pumps.set(w, (p = new PumpLook(this.scene)));
    return p;
  }

  /** The burst that announces each cast. */
  private castBurst(w: Wizard, spell: string, pos: THREE.Vector3): void {
    const chest = w.chest(tmp);
    switch (spell) {
      case 'carpet':
        this.fx.sparks.burst(tmp2.set(w.pos.x, w.pos.y + 0.3, w.pos.z), 26, GOLD, 2.6, 2, 6, 0.12, 0.5, { drag: 3, gravity: -1 });
        this.fx.dust(tmp2.set(w.pos.x, 0.1, w.pos.z), 6, 1.2);
        this.fx.flash(tmp2.set(w.pos.x, w.pos.y + 0.4, w.pos.z), 0xffb347, 2.2, 0.18);
        break;
      case 'pump':
        this.fx.sparks.burst(chest, 30, GREEN, 3, 2, 7, 0.12, 0.6, { drag: 2.5, gravity: -3 }, 3);
        this.fx.sparks.burst(chest, 14, GOLD, 2.6, 2, 5, 0.1, 0.5, { drag: 2, gravity: 6 }, 4);
        this.fx.flash(chest, 0x5dff8a, 2.6, 0.2);
        this.fx.ring(w.pos, 0x5dff8a, 2.4, 0.45);
        break;
      case 'vape':
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 3;
          this.fx.smoke.emit(pos.x, 0.4 + Math.random() * 1.2, pos.z, Math.cos(a) * s, 0.4 + Math.random(), Math.sin(a) * s,
            VAPOR, 1, 0.8 + Math.random() * 0.6, 1.2 + Math.random() * 0.8, { drag: 2.2, gravity: -0.3, sizeEnd: 2.8 });
        }
        break;
      case 'lockon':
        this.fx.ring(w.pos, 0x5dff8a, 3.2, 0.4);
        this.fx.flash(chest, 0x5dff8a, 1.8, 0.14);
        break;
      case 'breath':
        w.castPoint('blast', tmp2);
        this.fx.flash(tmp2, 0xff7a2a, 2.4, 0.2);
        break;
    }
  }

  /** Per rendered frame (after the wizards' visuals), `dt` scaled like the simulation's effects. */
  update(dt: number, projectiles: readonly Projectile[]): void {
    this.time += dt;
    let breathing: Wizard | null = null;
    for (const w of this.wizards) {
      if (w.riding || this.carpets.has(w)) this.carpetFor(w).update(w, dt, this.time);
      if (w.pumped || this.pumps.has(w)) this.pumpFor(w).update(w, dt, this.time);
      if (w.breathing && w.alive) breathing = w;
      if (dt <= 0) continue;
      if (w.riding) this.carpetSparkle(w, dt);
      if (w.scorched && w.alive) this.scorchFlames(w, dt);
    }
    // Wizards that left the fight (a parked partner) keep their looks hidden.
    for (const [w, c] of this.carpets) if (!this.wizards.includes(w)) c.mesh.visible = false;
    for (const [w, p] of this.pumps) if (!this.wizards.includes(w)) p.group.visible = false;
    if (breathing && dt > 0) this.flames(breathing, dt);
    this.breathLight.intensity = THREE.MathUtils.damp(this.breathLight.intensity, breathing ? 28 + Math.sin(this.time * 31) * 6 : 0, 14, Math.max(dt, 1e-3));
    // Lock-On bolts leave green motes.
    if (dt > 0) {
      for (const p of projectiles) if (p.active && p.seek && Math.random() < 0.7) this.fx.trail(p.pos, 0x5dff8a, 0.14, 1);
    }
  }

  private carpetSparkle(w: Wizard, dt: number): void {
    if (Math.random() > dt * 30) return;
    const s = Math.sin(w.facing), c = Math.cos(w.facing);
    const side = Math.random() < 0.5 ? -0.5 : 0.5, along = (Math.random() - 0.5) * 1.5;
    this.fx.sparks.emit(w.pos.x + side * c + along * s, w.pos.y - 0.05, w.pos.z - side * s + along * c, -w.vel.x * 0.15, -0.3, -w.vel.z * 0.15,
      GOLD, 2.2, 0.08, 0.45, { drag: 2 });
  }

  /** Small flames licking up a burning wizard. */
  private scorchFlames(w: Wizard, dt: number): void {
    const n = Math.random() < dt * 22 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const h = (0.2 + Math.random() * 1.4) * w.sizeScale;
      this.fx.sparks.emit(w.pos.x + (Math.random() - 0.5) * w.radius * 1.6, w.pos.y + h, w.pos.z + (Math.random() - 0.5) * w.radius * 1.6,
        (Math.random() - 0.5) * 0.4, 1.4 + Math.random(), (Math.random() - 0.5) * 0.4, Math.random() < 0.5 ? FLAME_A : FLAME_B, 2.4, 0.16, 0.4, { drag: 1.5 });
    }
  }

  /** The cone of fire: fast flames from the staff out to the breath's range, smoke at the far end. */
  private flames(w: Wizard, dt: number): void {
    const B = RS.breath;
    const origin = w.castPoint('blast', tmp);
    const dir = tmp2.subVectors(w.aimPoint, origin);
    if (dir.lengthSq() < 1) w.forward(dir);
    dir.normalize();
    this.breathLight.position.copy(origin).addScaledVector(dir, 1.5);
    const spread = Math.tan(THREE.MathUtils.degToRad(B.coneDegrees / 2));
    this.flameAcc += dt * 260;
    while (this.flameAcc >= 1) {
      this.flameAcc -= 1;
      const life = 0.28 + Math.random() * 0.12;
      const speed = B.range / life;
      // A random direction inside the cone.
      const rx = (Math.random() * 2 - 1) * spread, ry = (Math.random() * 2 - 1) * spread * 0.7;
      const ux = -dir.z, uz = dir.x; // horizontal perpendicular
      const vx = dir.x + ux * rx, vy = dir.y + ry, vz = dir.z + uz * rx;
      const l = Math.hypot(vx, vy, vz);
      const t = Math.random();
      tmpColor.copy(t < 0.25 ? FLAME_HOT : t < 0.65 ? FLAME_A : FLAME_B);
      this.fx.sparks.emit(origin.x, origin.y, origin.z, (vx / l) * speed, (vy / l) * speed + 0.8, (vz / l) * speed,
        tmpColor, 2.8, 0.22 + Math.random() * 0.2, life, { drag: 1.2 });
    }
    if (Math.random() < dt * 14) {
      const d = B.range * (0.6 + Math.random() * 0.4);
      this.fx.smoke.emit(origin.x + dir.x * d, origin.y + dir.y * d + 0.3, origin.z + dir.z * d, dir.x * 1.5, 1 + Math.random(), dir.z * 1.5,
        SMOKE, 1, 0.6, 0.9, { drag: 1.5, gravity: -0.8, sizeEnd: 1.8 });
    }
  }

  clear(): void {
    for (const c of this.carpets.values()) {
      c.show = 0;
      c.mesh.visible = false;
    }
    for (const p of this.pumps.values()) {
      p.show = 0;
      p.group.visible = false;
    }
    this.breathLight.intensity = 0;
  }
}
