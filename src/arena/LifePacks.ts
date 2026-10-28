import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader } from '../assets/AssetLoader';
import { events } from '../core/events';
import { rand } from '../core/math';
import type { Effects } from '../fx/Effects';
import { glowTexture } from '../fx/textures';
import type { Physics } from '../physics/Physics';
import type { Wizard } from '../wizard/Wizard';
import type { Arena } from './Arena';
import type { GoldenTickets } from './GoldenTickets';

const L = CONFIG.lifePacks;
const RED = 0xff2f45;
const RED_HI = 0xffc2c8;
const HEAL = 0x5cff8a;
const HEAL_HI = 0xd8ffe2;
const POP_TIME = 0.5;
const VANISH_TIME = 0.3;

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.5);
    float pulse = 0.7 + 0.3 * sin(vUv.y * 22.0 - uTime * 6.0);
    float a = fade * pulse * pow(vFacing, 1.3) * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + 1.8 * fade), a);
  }
`;

const TK = CONFIG.tickets;
const HEAL_COLOR = new THREE.Color(HEAL);
const HEAL_HI_COLOR = new THREE.Color(HEAL_HI);
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const tmpPos = new THREE.Vector3();

/** The life pack on the floor (one at a time). `id` is new on every spawn. */
export class LifePack {
  active = false;
  id = 0;
  /** Centre at hover height (without the bob). */
  readonly pos = new THREE.Vector3();
  /** Seconds on the floor (fight phase only). */
  age = 0;
  readonly root = new THREE.Group();
  /** The flask (GLB or code-built), spun and bobbed about its centre. */
  readonly body = new THREE.Group();
  readonly glow: THREE.Sprite;
  readonly beam: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  readonly floorGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  popTime = 0;
  vanishTime = 0;
  spin = 0;
  sparkAcc = 0;

  get remaining(): number {
    return L.lifetime - this.age;
  }

  constructor() {
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: RED, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.6,
    }));
    this.glow.renderOrder = 11;
    const beamGeo = new THREE.CylinderGeometry(0.34, 0.22, L.beamHeight, 18, 1, true).translate(0, L.beamHeight / 2 + L.hoverHeight + 0.5, 0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uColor: { value: new THREE.Color(RED) }, uOpacity: { value: 0.6 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.beam.renderOrder = 10;
    this.floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: glowTexture(), color: RED, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.5,
    }));
    this.floorGlow.position.y = 0.03;
    this.floorGlow.renderOrder = 8;
    this.root.add(this.body, this.glow, this.beam, this.floorGlow);
    this.root.visible = false;
  }
}

/** A code-built life pack (no GLB): a red glass potion flask with a white cross and a cork. */
function buildFlask(size: number): THREE.Group {
  const g = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({ color: 0xd8162c, emissive: 0xff1a35, emissiveIntensity: 0.55, roughness: 0.18, metalness: 0.1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.65, roughness: 0.4 });
  const cork = new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.8 });
  const k = size;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.32 * k, 20, 14), glass);
  bulb.position.y = -0.12 * k;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * k, 0.13 * k, 0.26 * k, 14), glass);
  neck.position.y = 0.3 * k;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * k, 0.1 * k, 0.1 * k, 12), cork);
  top.position.y = 0.48 * k;
  g.add(bulb, neck, top);
  // A white cross on both faces.
  for (const side of [1, -1]) {
    const bar1 = new THREE.Mesh(new THREE.BoxGeometry(0.26 * k, 0.08 * k, 0.03 * k), white);
    const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.08 * k, 0.26 * k, 0.03 * k), white);
    bar1.position.set(0, -0.1 * k, side * 0.31 * k);
    bar2.position.copy(bar1.position);
    g.add(bar1, bar2);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

/**
 * Life packs: health pickups in Boss Gauntlet fights (one life, long fights). At most
 * `CONFIG.lifePacks.maxPerFight` appear over a whole fight, one at a time: each boss stage brings
 * one, `firstDelay` s in, or sooner when the player is low. Only the player can collect one; it
 * heals `heal` of max health. An uncollected pack vanishes after `lifetime` s (it still counts).
 * Spawn spots reuse the golden tickets' checks (inside the fire ring, open floor by a physics query,
 * no lava, clouds or rails, away from wizards and tickets), a dash from the player and away from
 * the bosses.
 *
 * Fixed-tick `update` owns timing, spawning and pickups (while `enabled`: the fight phase of a
 * gauntlet fight); `updateVisual` animates the pack. Announces lifePackSpawn, lifePackPickup and
 * lifePackExpire. `reset` starts a fresh fight's budget (every match start, so Retry too).
 */
export class LifePacks {
  /** Spawning, ageing and pickups run only while true (Match: a gauntlet fight's fight phase; the soak). */
  enabled = false;
  readonly pack = new LifePack();
  /** This fight so far. */
  spawned = 0;
  collected = 0;
  expired = 0;
  private nextId = 1;
  /** Fight-phase seconds in the current boss stage, and that stage. */
  private stageTime = 0;
  private stageSeen = -1;
  /** When the current stage's pack is due (stage seconds). */
  private dueAt = 0;
  /** Seconds since the last pack ended (collected or expired); starts open. */
  private sinceLast = 1e9;
  private retry = 0;
  private visualTime = 0;
  private hasModel = false;

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly fx: Effects,
    /** Who may collect (the player). */
    private readonly player: Wizard,
    /** The live list of the player's opponents (kept away from spawn spots). */
    private readonly enemies: readonly Wizard[],
    private readonly tickets: GoldenTickets,
    private readonly arena: Arena,
    /** The furthest boss stage reached this fight (0..2); packs unlock one per stage. */
    private readonly stage: () => number,
    assets: AssetLoader,
  ) {
    const model = assets.instantiate('lifePack');
    if (model) {
      this.hasModel = true;
      // The GLB stands on y = 0: centre it on the spin pivot, and give it a red glow of its own.
      model.root.position.y = -L.size / 2;
      model.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'emissive' in m) {
          const c = m.clone();
          c.emissive.setHex(RED);
          c.emissiveIntensity = 0.28;
          (o as THREE.Mesh).material = c;
        }
      });
      this.pack.body.add(model.root);
    } else {
      this.pack.body.add(buildFlask(L.size / 0.9));
    }
    scene.add(this.pack.root);
    this.reset();
  }

  /** A real model (public/assets/models/pickups/life_pack.glb) is used, not the code-built flask. */
  get usesModel(): boolean {
    return this.hasModel;
  }

  /** Packs this fight can still produce. */
  get remaining(): number {
    return Math.max(0, L.maxPerFight - this.spawned);
  }

  /** A new fight: the full budget again, nothing on the floor. */
  reset(): void {
    this.spawned = this.collected = this.expired = 0;
    this.stageSeen = -1;
    this.stageTime = 0;
    this.sinceLast = 1e9;
    this.retry = 0;
    this.clearPack();
  }

  /** Remove the pack on the floor without it counting as anything (round reset). */
  clearPack(): void {
    const p = this.pack;
    p.active = false;
    p.vanishTime = 0;
    p.root.visible = false;
  }

  // ------------------------------------------------------------------ simulation (fixed tick)

  update(dt: number): void {
    const p = this.pack;
    if (p.active && Math.hypot(p.pos.x, p.pos.z) > this.arena.fireRadius - TK.fireBurnMargin) this.expire();
    if (!this.enabled) return;
    const stage = this.stage();
    if (stage !== this.stageSeen) {
      this.stageSeen = stage;
      this.stageTime = 0;
      this.dueAt = rand(L.firstDelay[0], L.firstDelay[1]);
    }
    this.stageTime += dt;
    this.sinceLast += dt;
    if (p.active) {
      p.age += dt;
      if (p.age >= L.lifetime) this.expire();
      else if (this.touching(this.player)) this.collect(this.player);
      return;
    }
    if (this.retry > 0) {
      this.retry -= dt;
      return;
    }
    if (this.isDue() && !this.spawn()) this.retry = L.retryDelay;
  }

  /** A pack should appear now (none on the floor). */
  isDue(): boolean {
    if (this.spawned >= Math.min(L.maxPerFight, this.stageSeen + 1) || this.sinceLast < L.minGap) return false;
    const low = this.player.alive && this.player.health < this.player.maxHealth * L.lowHealth && this.stageTime >= L.lowHealthDelay;
    return low || this.stageTime >= this.dueAt;
  }

  private touching(w: Wizard): boolean {
    const p = this.pack;
    return w.alive && w.pos.y <= L.pickupMaxHeight && Math.hypot(w.pos.x - p.pos.x, w.pos.z - p.pos.z) <= L.pickupRadius;
  }

  /** Heal `w` (never above max health) and remove the pack. */
  collect(w: Wizard): void {
    const p = this.pack;
    if (!p.active) return;
    const before = w.health;
    w.health = Math.min(w.maxHealth, w.health + w.maxHealth * L.heal);
    const healed = w.health - before;
    this.collected++;
    this.end();
    const fx = this.fx;
    tmpColor.setHex(RED);
    fx.sparks.burst(p.pos, 40, tmpColor, 3, 3, 8, 0.2, 0.7, { gravity: 4, drag: 2.2 }, 2);
    fx.flash(p.pos, RED, 3.4, 0.22);
    // Heal: green motes spiralling up the wizard, a ring and a soft green flash.
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 6;
      const r = 0.55 + 0.25 * Math.sin(i);
      fx.sparks.emit(w.pos.x + Math.sin(a) * r, w.pos.y + 0.05 + i * 0.06, w.pos.z + Math.cos(a) * r,
        Math.cos(a) * 1.4, 2.2, -Math.sin(a) * 1.4, i % 3 ? HEAL_COLOR : HEAL_HI_COLOR, 2.8, 0.14, 0.85, { drag: 1.5 });
    }
    fx.ring(w.pos, HEAL, 3.2, 0.5);
    fx.flash(w.chest(tmpPos), HEAL, 3, 0.3);
    fx.light(tmpPos, HEAL, 22, 0.5);
    events.emit('lifePackPickup', { id: p.id, pos: p.pos, wizard: w, healed });
  }

  private expire(): void {
    const p = this.pack;
    this.expired++;
    this.end();
    tmpColor.setHex(RED);
    this.fx.sparks.burst(p.pos, 18, tmpColor, 2, 1, 3.5, 0.13, 0.5, { gravity: 3, drag: 2.5 });
    this.fx.flash(p.pos, RED, 1.6, 0.14);
    events.emit('lifePackExpire', { id: p.id, pos: p.pos });
  }

  private end(): void {
    this.pack.active = false;
    this.pack.vanishTime = VANISH_TIME;
    this.sinceLast = 0;
  }

  /** Try random spots until one is valid; false if none was found this time. */
  spawn(): boolean {
    if (this.arena.fireRadius - TK.fireMargin < 1) return false;
    const pl = this.player.pos;
    for (let i = 0; i < L.spawnAttempts; i++) {
      // Around the player, inside the ring.
      const d = rand(L.playerDistance[0], L.playerDistance[1]);
      const a = Math.random() * Math.PI * 2;
      const x = pl.x + Math.sin(a) * d, z = pl.z + Math.cos(a) * d;
      if (this.isValidSpot(x, z)) return this.spawnAt(x, z) !== null;
    }
    return false;
  }

  /**
   * Open floor for a pack: everything a golden ticket needs (inside the ring, no lava, clouds or
   * rails, clear of obstacles, wizards and tickets), `playerDistance` from the player and at least
   * `bossDistance` from every standing boss.
   */
  isValidSpot(x: number, z: number): boolean {
    const pl = this.player.pos;
    const dp = Math.hypot(pl.x - x, pl.z - z);
    if (dp < L.playerDistance[0] - 1e-6 || dp > L.playerDistance[1] + 1e-6) return false;
    for (const e of this.enemies) if (e.alive && Math.hypot(e.pos.x - x, e.pos.z - z) < L.bossDistance) return false;
    return this.tickets.isValidSpot(x, z);
  }

  /** Put the pack at (x, z) without any checks (QA). Null if one is already out or the budget is spent. */
  spawnAt(x: number, z: number): LifePack | null {
    const p = this.pack;
    if (p.active || this.spawned >= L.maxPerFight) return null;
    const first = this.spawned === 0;
    this.spawned++;
    p.active = true;
    p.id = this.nextId++;
    p.age = 0;
    p.pos.set(x, L.hoverHeight, z);
    p.popTime = 0;
    p.vanishTime = 0;
    p.spin = Math.random() * Math.PI * 2;
    p.sparkAcc = 0;
    p.root.position.set(x, 0, z);
    p.root.visible = true;
    tmpColor.setHex(RED);
    this.fx.sparks.burst(p.pos, 34, tmpColor, 2.8, 2, 6, 0.16, 0.6, { gravity: 2, drag: 2.5 }, 1);
    this.fx.flash(p.pos, RED, 3.2, 0.28);
    this.fx.ring(p.pos, RED, 2.6, 0.55);
    events.emit('lifePackSpawn', { id: p.id, pos: p.pos, first, left: this.remaining });
    return p;
  }

  /** AI helper: the pack, if one is out within `range` of `self` and in sight. */
  bestFor(self: Wizard, range: number): LifePack | null {
    const p = this.pack;
    if (!p.active) return null;
    if (Math.hypot(self.pos.x - p.pos.x, self.pos.z - p.pos.z) > range) return null;
    return this.physics.lineOfSight(self.chest(tmpPos), p.pos) ? p : null;
  }

  // ------------------------------------------------------------------ visuals (per frame)

  updateVisual(dt: number, eye?: THREE.Vector3): void {
    this.visualTime += dt;
    const time = this.visualTime;
    const p = this.pack;
    if (!p.root.visible) return;
    let scale: number;
    let alpha = 1;
    if (p.active) {
      p.popTime += dt;
      const k = Math.min(1, p.popTime / POP_TIME);
      scale = easeOutBack(k);
      p.spin += L.spinSpeed * dt;
      if (p.remaining < L.blinkTime) {
        const hz = 2.5 + (1 - p.remaining / L.blinkTime) * 6;
        alpha = Math.sin(time * hz * Math.PI * 2) > -0.2 ? 1 : 0.2;
      }
      p.sparkAcc += dt * L.sparkleRate;
      tmpColor.setHex(RED);
      tmpColor2.setHex(RED_HI);
      while (p.sparkAcc >= 1) {
        p.sparkAcc -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = 0.35 + Math.random() * 0.45;
        this.fx.sparks.emit(
          p.pos.x + Math.sin(a) * r, p.pos.y - 0.6 + Math.random() * 1.1, p.pos.z + Math.cos(a) * r,
          Math.sin(a) * 0.2, 0.6 + Math.random() * 0.8, Math.cos(a) * 0.2,
          Math.random() < 0.35 ? tmpColor2 : tmpColor, 2.4, 0.07 + Math.random() * 0.07, 0.6 + Math.random() * 0.5, { drag: 1.2 },
        );
      }
    } else {
      p.vanishTime -= dt;
      if (p.vanishTime <= 0) {
        p.root.visible = false;
        return;
      }
      const k = p.vanishTime / VANISH_TIME;
      scale = k * (1.4 - 0.4 * k);
      alpha = k;
    }
    // A heartbeat pulse: two quick beats a second.
    const beat = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2.2)), 8);
    const bob = Math.sin(time * L.bobSpeed) * L.bobAmplitude;
    p.body.position.y = p.pos.y + bob;
    p.body.rotation.set(0.1 * Math.sin(time * 1.4), p.spin, 0);
    p.body.scale.setScalar(Math.max(0.001, scale * (1 + 0.1 * beat)));
    p.body.visible = alpha > 0.5;
    let far = 1;
    if (eye) {
      tmpPos.set(p.root.position.x - eye.x, 0, p.root.position.z - eye.z);
      far = Math.min(2.6, Math.max(1, tmpPos.length() / 16));
    }
    p.glow.position.set(0, p.body.position.y, 0);
    p.glow.scale.setScalar(2.2 * Math.max(0.001, scale) * (0.9 + 0.35 * beat) * (1 + (far - 1) * 0.5));
    p.glow.material.opacity = 0.55 * alpha;
    const u = p.beam.material.uniforms;
    u.uTime.value = time;
    u.uOpacity.value = 0.7 * alpha * Math.min(1, p.active ? p.popTime / POP_TIME : 1) * (0.8 + 0.2 * beat);
    p.beam.scale.set(scale * far, 1, scale * far);
    p.floorGlow.material.opacity = 0.55 * alpha * (0.75 + 0.25 * beat);
  }
}

function easeOutBack(p: number): number {
  const c = 2.2;
  const x = p - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
